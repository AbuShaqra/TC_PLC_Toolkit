/**
 * @file .claude/memory/bank.js
 * @description Reads the repo's shared memory bank and emits it as session-start context.
 *
 * ## Why a hook instead of pointing Claude's memory directory at the repo
 *
 * Claude Code's own auto-memory lives outside the repo, under
 * `~/.claude/projects/<sanitized-cwd>/memory/` — per machine, and invisible to everyone else. The
 * obvious fix is the `autoMemoryDirectory` setting, but it is **deliberately ignored when it comes
 * from a checked-in `.claude/settings.json`**, so a repo cannot redirect it. Each machine would have
 * to opt in by hand, and a machine that forgot would silently lose every shared note.
 *
 * A `SessionStart` hook has none of that: it is declared in the committed `.claude/settings.json`,
 * so cloning the repo is the whole setup. It also leaves the per-machine memory bank alone, which is
 * the right home for anything genuinely local.
 *
 * ## Usage
 *
 *     node .claude/memory/bank.js            # emit the hook JSON (what SessionStart runs)
 *     node .claude/memory/bank.js --digest   # the same text, unwrapped, for reading by eye
 *     node .claude/memory/bank.js --check    # validate every note; exit 1 on a problem
 *
 * Paths resolve from `__dirname`, never the working directory, because a hook's cwd is not
 * guaranteed to be the project root.
 *
 * ## Failure policy: stay quiet, never break the session
 *
 * Anything unexpected exits 0 having printed nothing. A hook that errors on every session start
 * would be worse than one that occasionally says nothing, and `--check` is where problems are meant
 * to surface — it runs in the test suite (`test/test_memory_bank.js`), where a malformed note fails
 * loudly and in front of someone who can fix it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

/**
 * Parses one note. Returns null when the file is not a well-formed memory — the caller decides
 * whether that is "skip it" (digest) or "fail" (--check).
 * @param {string} file Absolute path.
 * @returns {?{file: string, name: string, description: string, type: string, links: string[]}}
 */
function readNote(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return null;
    }
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;

    // Deliberately not a YAML parser: the frontmatter here is three flat keys plus a nested `type`,
    // and taking a dependency for that would be the only dependency in a repo that has none.
    const field = key => {
        const m = fm[1].match(new RegExp('^\\s*' + key + ':\\s*(.*)$', 'm'));
        if (!m) return '';
        const raw = m[1].trim();
        const quoted = raw.match(/^"(.*)"$/);
        // A double-quoted value carries `\"` for an inner quote; leaving those escaped put literal
        // backslashes into the digest a session actually reads.
        if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const single = raw.match(/^'(.*)'$/);
        return single ? single[1] : raw;
    };
    const name = field('name');
    const description = field('description');
    if (!name || !description) return null;

    return {
        file: path.basename(file),
        name,
        description,
        type: field('type') || 'unknown',
        links: [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1])
    };
}

/**
 * Every note in the bank, sorted by name so the digest is stable and diffs stay readable.
 * @returns {Array<Object>}
 */
function readBank() {
    let files;
    try {
        files = fs.readdirSync(DIR);
    } catch (e) {
        return [];
    }
    return files
        .filter(f => f.endsWith('.md') && f !== 'README.md')
        .map(f => readNote(path.join(DIR, f)))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The text injected at session start: one line per note, plus how to read and add them. Descriptions
 * are the whole point — they are what lets a session decide which note is worth opening.
 * @param {Array<Object>} notes
 * @returns {string}
 */
function digest(notes) {
    if (!notes.length) return '';
    const lines = notes.map(n => `- **${n.name}** — ${n.description}  \`.claude/memory/${n.file}\``);
    return [
        'Shared project memory (version-controlled in this repo, so it follows the work across machines).',
        'These are lessons already paid for here. Read the full note before acting on anything it covers —',
        'the one-liners below are an index, not the content.',
        '',
        ...lines,
        '',
        'This bank is for lessons that hold on ANY machine. Your per-machine auto-memory still applies and',
        'is the place for anything genuinely local. To add a shared note: write a new `.claude/memory/<slug>.md`',
        'with `name`/`description`/`metadata.type` frontmatter — it is version-controlled, so it lands in the',
        'next commit like any other change. See `.claude/memory/README.md`.'
    ].join('\n');
}

/**
 * Validates the bank. Reports everything it finds rather than the first thing, so one run fixes the
 * lot.
 *
 * Problems and warnings are separated because only one of them means the bank is broken. A dangling
 * `[[link]]` is explicitly legal — it marks a note worth writing later — so it must never fail a
 * build; it is still worth printing, because the other way to get one is linking to a note that only
 * exists in somebody's local bank, which would never resolve for anyone else.
 * @returns {{problems: string[], warnings: string[]}}
 */
function check() {
    const problems = [];
    const warnings = [];
    let files;
    try {
        files = fs.readdirSync(DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
    } catch (e) {
        return { problems: ['cannot read ' + DIR + ': ' + e.message], warnings: [] };
    }
    if (!files.length) problems.push('the bank is empty');

    const notes = [];
    for (const f of files) {
        const note = readNote(path.join(DIR, f));
        if (!note) {
            problems.push(`${f}: missing or malformed frontmatter (needs name + description)`);
            continue;
        }
        notes.push(note);
        // The name is the link target other notes use, so a name that does not match its filename
        // makes [[wikilinks]] unresolvable in a way nothing else would catch.
        if (note.name !== f.replace(/\.md$/, '')) {
            problems.push(`${f}: frontmatter name "${note.name}" does not match the filename`);
        }
        if (!['user', 'feedback', 'project', 'reference'].includes(note.type)) {
            problems.push(`${f}: metadata.type "${note.type}" is not user|feedback|project|reference`);
        }
        if (note.description.length > 200) {
            problems.push(`${f}: description is ${note.description.length} chars — it is an index line, keep it under 200`);
        }
    }

    const names = notes.map(n => n.name);
    for (const n of notes) {
        for (const link of n.links) {
            if (!names.includes(link)) warnings.push(`${n.file}: [[${link}]] resolves to nothing in the shared bank`);
        }
    }
    return { problems, warnings };
}

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--check') {
        const { problems, warnings } = check();
        const notes = readBank();
        for (const p of problems) console.error('  [problem] ' + p);
        for (const w of warnings) console.log('  [note]    ' + w);
        console.log(`${notes.length} shared memory note(s), ${problems.length} problem(s), ${warnings.length} dangling link(s)`);
        process.exit(problems.length ? 1 : 0);
    }
    try {
        const text = digest(readBank());
        if (!text) process.exit(0);
        if (arg === '--digest') {
            console.log(text);
        } else {
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
                suppressOutput: true
            }));
        }
    } catch (e) {
        // See the header: a hook that throws on every session start is worse than a quiet one.
    }
    process.exit(0);
}

module.exports = { readBank, readNote, digest, check };
