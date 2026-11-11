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
 * defines to give the compiler); each non-empty one gets a note, since `{IF defined(...)}` in that object
 * then takes its ELSE branch. Several `<CompilerDefines>` in property groups follow MSBuild: the
 * last wins, and `$(CompilerDefines)` in it stands for the value before.
 *
 * A `Condition` on the property group or on the element is evaluated for one build configuration,
 * `CHECK_CONFIGURATION` (Debug, TwinCAT RT (x64)), by `evaluateCondition`: true applies it in document
 * order, false skips it silently (a Release-only group is normal), and a condition it cannot read or
 * decide (`Exists(...)`, a property function, `<`) leaves the group or element out, with a note.
 *
 * Define names are case-sensitive and kept exactly as written.
 */

'use strict';

const fs = require('fs');

/** A define name, as the compiler accepts it (`-D` refuses anything else). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The build configuration a `Condition` is evaluated for: `$(Configuration)` and `$(Platform)`.
 * One place, so a later setting can change it.
 */
const CHECK_CONFIGURATION = Object.freeze({ configuration: 'Debug', platform: 'TwinCAT RT (x64)' });

/** XML attribute text: quoted values may hold `>`. */
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*?)`;

/**
 * @typedef {Object} CompilerDefine
 * @property {string} name As written (case kept).
 * @property {string|null} value The text between the quotes of `NAME := 'value'`; null for a bare `NAME`.
 */

/**
 * @typedef {Object} DefineList
 * @property {CompilerDefine[]} defines In list order; a name given twice keeps its last entry, at its last place.
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
 * Expands `$(Name)` property references (MSBuild names are case-insensitive; an undefined one is '').
 * @param {string} text
 * @param {Map<string, string|null>} props Keyed by lower-case name; null = set to something not readable.
 * @returns {string|null} null when the text uses a property whose value is not readable, or anything
 * else MSBuild would expand (`$([...])`, `@(...)`, `%(...)`, `$(X.Y())`).
 */
function expandProps(text, props) {
    const ref = /\$\(\s*([A-Za-z_][\w-]*)\s*\)/g;
    if (/[$@%]\(/.test(text.replace(ref, ''))) return null;
    let unreadable = false;
    const out = text.replace(ref, (all, name) => {
        const v = props.get(name.toLowerCase());
        if (v === null) unreadable = true;
        return v || '';
    });
    return unreadable ? null : out;
}

/** Thrown inside evaluateCondition for text it cannot read; never escapes it. */
class ConditionSyntax extends Error {}

/**
 * Evaluates an MSBuild `Condition` for the given properties. Reads the forms `.plcproj` files use:
 * `'$(Configuration)|$(Platform)' == 'Debug|TwinCAT RT (x64)'`, `'$(Configuration)' != 'Release'`,
 * `==` / `!=` compared case-insensitively (numerically when both sides are numbers), `And` / `Or` / `!`
 * and parentheses, bare `true` / `false`. `Exists(...)` and any other function are undecided; with
 * `And` / `Or` a decided side can still settle the result (`false And Exists(x)` is false). Never throws.
 * @param {string} condition The attribute's text, XML-decoded.
 * @param {Map<string, string|null>} props Property values keyed by lower-case name (Configuration, Platform, …); null = unreadable.
 * @returns {boolean|null} null: not readable or not decidable.
 */
function evaluateCondition(condition, props) {
    try {
        const tokens = tokenizeCondition(String(condition));
        let pos = 0;
        const peek = () => tokens[pos];
        const isWord = (t, w) => !!t && t.type === 'word' && t.text.toLowerCase() === w;
        /** @returns {boolean|null} */
        const orExpr = () => {
            let left = andExpr();
            while (isWord(peek(), 'or')) {
                pos++;
                const right = andExpr();
                left = left === true || right === true ? true : (left === false && right === false ? false : null);
            }
            return left;
        };
        const andExpr = () => {
            let left = unary();
            while (isWord(peek(), 'and')) {
                pos++;
                const right = unary();
                left = left === false || right === false ? false : (left === true && right === true ? true : null);
            }
            return left;
        };
        /** @returns {boolean|null} */
        const unary = () => {
            if (peek() && peek().type === '!') {
                pos++;
                const v = unary();
                return v === null ? null : !v;
            }
            return primary();
        };
        /** @returns {{kind: 'value', text: string}|{kind: 'unknown'}} */
        const operand = () => {
            const t = tokens[pos++];
            if (!t) throw new ConditionSyntax('expected a value');
            if (t.type === 'string' || t.type === 'prop') {
                const text = expandProps(t.text, props);
                if (text === null) throw new ConditionSyntax('unsupported expansion');
                return { kind: 'value', text };
            }
            if (t.type === 'word' && !['and', 'or'].includes(t.text.toLowerCase())) {
                if (peek() && peek().type === '(') {
                    // Exists(...), HasTrailingSlash(...): the check cannot decide them.
                    let depth = 0;
                    do {
                        const u = tokens[pos++];
                        if (!u) throw new ConditionSyntax('unclosed function call');
                        if (u.type === '(') depth++;
                        else if (u.type === ')') depth--;
                    } while (depth > 0);
                    return { kind: 'unknown' };
                }
                return { kind: 'value', text: t.text };
            }
            throw new ConditionSyntax(`unexpected ${t.type}`);
        };
        /** @returns {boolean|null} */
        const primary = () => {
            if (peek() && peek().type === '(') {
                pos++;
                const v = orExpr();
                if (!peek() || peek().type !== ')') throw new ConditionSyntax('expected )');
                pos++;
                return v;
            }
            const left = operand();
            const op = peek();
            if (op && (op.type === '==' || op.type === '!=')) {
                pos++;
                const right = operand();
                if (left.kind === 'unknown' || right.kind === 'unknown') return null;
                const same = sameValue(left.text, right.text);
                return op.type === '==' ? same : !same;
            }
            if (op && op.type === 'relational') throw new ConditionSyntax('relational operators are not read');
            if (left.kind === 'unknown') return null;
            const b = left.text.trim().toLowerCase();
            if (['true', 'on', 'yes'].includes(b)) return true;
            if (['false', 'off', 'no'].includes(b)) return false;
            throw new ConditionSyntax('not a boolean');
        };
        if (tokens.length === 0) return null;
        const result = orExpr();
        if (pos !== tokens.length) return null;
        return result;
    } catch {
        return null; // ConditionSyntax, or anything unforeseen: not decided
    }
}

/** MSBuild's `==`: numbers by value, anything else case-insensitively. */
function sameValue(a, b) {
    const num = (/** @type {string} */ x) => (/^\s*-?(\d+(\.\d+)?|0x[0-9a-f]+)\s*$/i.test(x) ? Number(x.trim()) : NaN);
    const na = num(a), nb = num(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
    return a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {string} text
 * @returns {{type: string, text: string}[]}
 */
function tokenizeCondition(text) {
    /** @type {{type: string, text: string}[]} */
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === "'") {
            const close = text.indexOf("'", i + 1);
            if (close < 0) throw new ConditionSyntax('unclosed quote');
            tokens.push({ type: 'string', text: text.slice(i + 1, close) });
            i = close + 1;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (two === '==' || two === '!=') { tokens.push({ type: two, text: two }); i += 2; continue; }
        if (two === '<=' || two === '>=') { tokens.push({ type: 'relational', text: two }); i += 2; continue; }
        if (ch === '<' || ch === '>') { tokens.push({ type: 'relational', text: ch }); i++; continue; }
        if (ch === '!' || ch === '(' || ch === ')' || ch === ',') { tokens.push({ type: ch, text: ch }); i++; continue; }
        if (ch === '$' && text[i + 1] === '(') {
            const close = text.indexOf(')', i);
            if (close < 0) throw new ConditionSyntax('unclosed $(');
            tokens.push({ type: 'prop', text: text.slice(i, close + 1) });
            i = close + 1;
            continue;
        }
        const word = /^[A-Za-z0-9_.\-:\\/]+/.exec(text.slice(i));
        if (!word) throw new ConditionSyntax(`unexpected "${ch}"`);
        tokens.push({ type: 'word', text: word[0] });
        i += word[0].length;
    }
    return tokens;
}

/** @param {string} attrs */
function conditionOf(attrs) {
    const m = /\bCondition\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    return m ? decodeXml(m[1] !== undefined ? m[1] : m[2]) : null;
}

/** @param {{configuration: string, platform: string}} config */
const configLabel = (config) => `${config.configuration}|${config.platform}`;

/**
 * Reads the project's compiler defines from a `.plcproj` text, for one build configuration.
 * @param {string} xml
 * @param {{configuration: string, platform: string}} [config] Default: CHECK_CONFIGURATION.
 * @returns {DefineList}
 */
function readCompilerDefines(xml, config = CHECK_CONFIGURATION) {
    const text = String(xml || '').replace(/<!--[\s\S]*?-->/g, '');
    /** @type {string[]} */
    const problems = [];
    /** @type {string|null} */
    let value = null;
    /** @type {Map<string, string|null>} Properties set so far (null: set to something not readable). */
    const props = new Map();
    const fixed = new Map([['configuration', config.configuration], ['platform', config.platform]]);
    const allProps = () => new Map([...props, ...fixed]);
    const groupRe = new RegExp(`<PropertyGroup\\b${ATTRS}(\\/?)>([\\s\\S]*?)(?:<\\/PropertyGroup\\s*>|$)`, 'g');
    let group;
    while ((group = groupRe.exec(text)) !== null) {
        if (group[2] === '/') continue;
        const body = group[3];
        const groupCond = conditionOf(group[1]);
        if (groupCond !== null) {
            const v = evaluateCondition(groupCond, allProps());
            if (v === false) continue;
            if (v === null) {
                if (/<CompilerDefines\b/.test(body)) {
                    problems.push(`a <CompilerDefines> in a property group whose Condition="${groupCond}" cannot be evaluated for ` +
                        `${configLabel(config)} was not used`);
                }
                continue;
            }
        }
        const elemRe = new RegExp(`<([A-Za-z_][\\w.-]*)\\b${ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g');
        let elem;
        while ((elem = elemRe.exec(body)) !== null) {
            const name = elem[1];
            const elemCond = conditionOf(elem[2]);
            if (elemCond !== null) {
                const v = evaluateCondition(elemCond, allProps());
                if (v === false) continue;
                if (v === null) {
                    if (name === 'CompilerDefines') {
                        problems.push(`a <CompilerDefines Condition="${elemCond}"> that cannot be evaluated for ${configLabel(config)} was not used`);
                    }
                    continue;
                }
            }
            const own = decodeXml(elem[3] || '');
            if (name === 'CompilerDefines') {
                value = own.replace(/\$\(CompilerDefines\)/gi, value || '');
                props.set('compilerdefines', value);
            } else if (!fixed.has(name.toLowerCase())) {
                props.set(name.toLowerCase(), expandProps(own, allProps()));
            }
        }
    }
    const itemRe = /<(\w+)\s[^>]*?\bInclude\s*=\s*"([^"]*)"[^>]*?(?<!\/)>([\s\S]*?)<\/\1\s*>/g;
    let item;
    while ((item = itemRe.exec(text)) !== null) {
        const own = /<CompilerDefines\b[^>]*>([\s\S]*?)<\/CompilerDefines\s*>/.exec(item[3]);
        const list = own ? decodeXml(own[1]).trim() : '';
        if (list) {
            problems.push(`per-object compiler defines on ${decodeXml(item[2])} (${list}) are not passed; ` +
                '{IF defined(...)} in that object uses its ELSE branch');
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
 * @param {{configuration: string, platform: string}} [config] The configuration a `Condition` is evaluated for.
 * @returns {{defines: CompilerDefine[], args: string[], notes: string[]}}
 */
function projectDefineArgs(plcprojPath, read = (p) => fs.readFileSync(p, 'utf8'), config = CHECK_CONFIGURATION) {
    if (!plcprojPath) return { defines: [], args: [], notes: [] };
    let xml;
    try {
        xml = read(plcprojPath);
    } catch (err) {
        const why = err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err);
        return { defines: [], args: [], notes: [`compiler defines not read: ${why}`] };
    }
    const list = readCompilerDefines(xml, config);
    const mapped = defineArgs(list.defines);
    return { defines: list.defines, args: mapped.args, notes: [...list.problems, ...mapped.notes] };
}

module.exports = { readCompilerDefines, parseDefineList, defineArgs, projectDefineArgs, evaluateCondition, CHECK_CONFIGURATION };
