/**
 * @file compilerDefines.js
 * @description A PLC project's compiler defines (the "Compiler defines" field of the project's
 * Compile settings, read by `{IF defined(X)}` / `{IF hasvalue(X, 'v')}` pragmas), read from its
 * `.plcproj`, and the compiler arguments that pass them to *Compile Project*. VS Code-free.
 *
 * Where TwinCAT keeps them: a `<CompilerDefines>` element in a `<PropertyGroup>` of the `.plcproj`
 * (an MSBuild file), holding a comma-separated list whose entries are `NAME` or `NAME := 'value'`:
 *
 *     <PropertyGroup>
 *       …
 *       <CompilerDefines>SIM, MODE := 'fast'</CompilerDefines>
 *     </PropertyGroup>
 *
 * An empty field is `<CompilerDefines />` or an element holding only whitespace. A `<CompilerDefines>`
 * inside an `<ItemGroup>` item (`<Compile Include="…">`) is a per-object define: it is not a project
 * define and is not read here (the check compiles the project as one unit, so it has no per-file
 * defines to give the compiler). Several `<CompilerDefines>` in property groups follow MSBuild: the
 * last wins, and `$(CompilerDefines)` in it stands for the value before. A property group with a
 * `Condition` is build-configuration specific and is ignored (said so in the notes).
 *
 * Define names are case-sensitive and kept exactly as written.
 */

'use strict';

const fs = require('fs');

/** A define name, as the compiler accepts it (`-D` refuses anything else). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @typedef {Object} CompilerDefine
 * @property {string} name As written (case kept).
 * @property {string|null} value The text between the quotes of `NAME := 'value'`; null for a bare `NAME`.
 */

/**
 * @typedef {Object} DefineList
 * @property {CompilerDefine[]} defines In list order; a name given twice keeps its last entry, at its first place.
 * @property {string[]} problems One line per entry that was skipped, or per part of the file not read.
 */

/** @param {string} text */
function decodeXml(text) {
    return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, e) => {
        if (e === 'lt') return '<';
        if (e === 'gt') return '>';
        if (e === 'amp') return '&';
        if (e === 'quot') return '"';
        if (e === 'apos') return "'";
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : all;
    });
}

/**
 * Splits a define list on the commas outside single quotes.
 * @param {string} text
 * @returns {{parts: string[], unterminated: boolean}}
 */
function splitList(text) {
    const parts = [];
    let current = '';
    let quoted = false;
    for (const ch of text) {
        if (ch === "'") quoted = !quoted;
        if (ch === ',' && !quoted) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    parts.push(current);
    return { parts, unterminated: quoted };
}

/**
 * Parses the text of a "Compiler defines" field.
 * @param {string} text The comma-separated list (already XML-decoded).
 * @returns {DefineList}
 */
function parseDefineList(text) {
    /** @type {Map<string, CompilerDefine>} */
    const byName = new Map();
    /** @type {string[]} */
    const problems = [];
    const { parts, unterminated } = splitList(String(text || ''));
    if (unterminated) {
        problems.push(`compiler defines "${String(text).trim()}": a quote is not closed; the list was not used`);
        return { defines: [], problems };
    }
    for (const raw of parts) {
        const entry = raw.trim();
        if (!entry) continue;
        const valued = /^([^\s:=']+)\s*:=\s*'([^']*)'$/.exec(entry);
        const name = valued ? valued[1] : entry;
        if (!NAME_RE.test(name) || (!valued && /[:=']/.test(entry))) {
            problems.push(`compiler define "${entry}" skipped: expected NAME or NAME := 'value' with NAME a plain identifier`);
            continue;
        }
        byName.delete(name);
        byName.set(name, { name, value: valued ? valued[2] : null });
    }
    return { defines: [...byName.values()], problems };
}

/**
 * Reads the project's compiler defines from a `.plcproj` text.
 * @param {string} xml
 * @returns {DefineList}
 */
function readCompilerDefines(xml) {
    const text = String(xml || '').replace(/<!--[\s\S]*?-->/g, '');
    /** @type {string[]} */
    const problems = [];
    /** @type {string|null} */
    let value = null;
    const groupRe = /<PropertyGroup\b([^>]*?)(\/?)>([\s\S]*?)(?:<\/PropertyGroup\s*>|$)/g;
    let group;
    while ((group = groupRe.exec(text)) !== null) {
        if (group[2] === '/') continue;
        const body = group[3];
        const elemRe = /<CompilerDefines\b[^>]*?(?:\/>|>([\s\S]*?)<\/CompilerDefines\s*>)/g;
        let elem;
        while ((elem = elemRe.exec(body)) !== null) {
            if (/\bCondition\s*=/.test(group[1])) {
                problems.push(`a <CompilerDefines> in a conditional property group (${group[1].trim()}) was not used`);
                continue;
            }
            const own = decodeXml(elem[1] || '');
            value = own.replace(/\$\(CompilerDefines\)/g, value || '');
        }
    }
    if (value === null) return { defines: [], problems };
    const parsed = parseDefineList(value);
    return { defines: parsed.defines, problems: [...problems, ...parsed.problems] };
}

/**
 * The compiler arguments for the defines. `NAME` → `-D NAME`; `NAME := 'v'` → `-D NAME=v`. The
 * compiler also turns a `-D NAME=v` whose `v` starts with an integer (JavaScript `parseInt`) into a
 * global constant `NAME`, which TwinCAT does not have: a project global of that name then reads as
 * declared twice, and an undeclared use of the name passes. Such a define is passed as `-D NAME`
 * instead (`defined(NAME)` is still true; `hasvalue(NAME, 'v')` is not), with a note.
 * @param {CompilerDefine[]} defines
 * @returns {{args: string[], notes: string[]}}
 */
function defineArgs(defines) {
    /** @type {string[]} */
    const args = [];
    /** @type {string[]} */
    const notes = [];
    for (const d of defines || []) {
        if (d.value === null) {
            args.push('-D', d.name);
        } else if (!Number.isNaN(parseInt(d.value, 10))) {
            args.push('-D', d.name);
            notes.push(`compiler define "${d.name} := '${d.value}'" passed as "${d.name}" only: hasvalue(${d.name}, …) is not checked ` +
                'for a value that starts with a number (the compiler would also declare a global constant of that name)');
        } else {
            args.push('-D', `${d.name}=${d.value}`);
        }
    }
    return { args, notes };
}

/**
 * The compiler arguments for one PLC project's defines, with every note to show. Never throws: an
 * unreadable `.plcproj` gives no defines and a note.
 * @param {string|undefined|null} plcprojPath
 * @param {(p: string) => string} [read] Reads a file as text (default: fs, UTF-8).
 * @returns {{defines: CompilerDefine[], args: string[], notes: string[]}}
 */
function projectDefineArgs(plcprojPath, read = (p) => fs.readFileSync(p, 'utf8')) {
    if (!plcprojPath) return { defines: [], args: [], notes: [] };
    let xml;
    try {
        xml = read(plcprojPath);
    } catch (err) {
        const why = err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err);
        return { defines: [], args: [], notes: [`compiler defines not read: ${why}`] };
    }
    const list = readCompilerDefines(xml);
    const mapped = defineArgs(list.defines);
    return { defines: list.defines, args: mapped.args, notes: [...list.problems, ...mapped.notes] };
}

module.exports = { readCompilerDefines, parseDefineList, defineArgs, projectDefineArgs };
