/**
 * @file values.js
 * @description Online monitoring (R15): PLC values as text and back. Formats what ads-client decodes
 * (numbers, BigInt for 64-bit types, booleans, strings, enums as `{name, value}`, dates) for the inline
 * boxes and the Watch view, and parses what the user types into a write for a scalar type. Only
 * scalars are written: a struct, FB or array is refused rather than half-written. vscode-free.
 */

'use strict';

/** Integer types and their inclusive ranges (BigInt, so 64-bit types are exact). */
const INT_RANGES = {
    SINT: [-128n, 127n], USINT: [0n, 255n], BYTE: [0n, 255n],
    INT: [-32768n, 32767n], UINT: [0n, 65535n], WORD: [0n, 65535n],
    DINT: [-2147483648n, 2147483647n], UDINT: [0n, 4294967295n], DWORD: [0n, 4294967295n],
    LINT: [-9223372036854775808n, 9223372036854775807n], ULINT: [0n, 18446744073709551615n], LWORD: [0n, 18446744073709551615n]
};
/** The 64-bit integer types, which ads-client reads and writes as BigInt. */
const BIG = new Set(['LINT', 'ULINT', 'LWORD']);

/** The longest value text an inline box shows before it is shortened. */
const INLINE_MAX = 40;
/** The longest value text the write modal and the log show before it is shortened. */
const TEXT_MAX = 200;

/**
 * The base type name a data type stands for: an alias resolves to what it aliases when ads-client has
 * built it that way, `STRING(80)` to `STRING`.
 * @param {any} dataType An ads-client `AdsDataType`, or a bare type string.
 * @returns {string}
 */
function baseTypeName(dataType) {
    const t = typeof dataType === 'string' ? dataType : (dataType && (dataType.type || dataType.name)) || '';
    return String(t).replace(/\(.*$/, '').trim().toUpperCase();
}

/**
 * Whether a value of this type fits on one line: no members and no array dimensions.
 * @param {any} dataType An ads-client `AdsDataType`.
 * @returns {boolean}
 */
function isScalar(dataType) {
    if (!dataType) return false;
    if (Array.isArray(dataType.subItems) && dataType.subItems.length > 0) return false;
    if (Array.isArray(dataType.arrayInfos) && dataType.arrayInfos.length > 0) return false;
    if (dataType.arrayDimension > 0) return false;
    if (/^\s*(POINTER|REFERENCE)\s+TO\b/i.test(String(dataType.name || dataType.type || ''))) return false;
    return true;
}

/**
 * Whether the type has enumerators.
 * @param {any} dataType
 * @returns {boolean}
 */
function isEnum(dataType) {
    return !!(dataType && Array.isArray(dataType.enumInfos) && dataType.enumInfos.length > 0);
}

/**
 * A decoded value as text. Strings are quoted the ST way; anything else uses its plain form.
 * @param {any} value
 * @param {any} [dataType]
 * @returns {string}
 */
function formatValue(value, dataType) {
    if (value === undefined || value === null) return '?';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
        const base = baseTypeName(dataType);
        if (base === 'TIME' || base === 'TON' || base === 'TIME_OF_DAY' || base === 'TOD') return `T#${value}ms`;
        if (Number.isInteger(value)) return String(value);
        return String(Number(value.toPrecision(7)));
    }
    if (typeof value === 'string') return quoteString(value, /^WSTRING/i.test(baseTypeName(dataType)));
    if (value instanceof Date) return isNaN(value.getTime()) ? '?' : value.toISOString().replace('.000Z', 'Z');
    if (typeof value === 'object' && 'name' in value && 'value' in value && Object.keys(value).length === 2) {
        return `${value.name} (${formatValue(value.value)})`;
    }
    if (Array.isArray(value)) return `[${value.length}]`;
    if (typeof value === 'object') return '{…}';
    return String(value);
}

/**
 * A PLC string as an ST literal on one line. The value comes from the PLC, so it is never trusted to
 * be printable: `$`, the quote, line breaks, tabs and every other control character are written as ST
 * escapes (`$$`, `$'`, `$N`, `$R`, `$T`, `$hh`), so it cannot add lines to a dialog or a log entry.
 * @param {string} value
 * @param {boolean} wide WSTRING (double quotes, `$hhhh` escapes).
 * @returns {string}
 */
function quoteString(value, wide) {
    const q = wide ? '"' : "'";
    let body = '';
    for (const ch of String(value)) {
        if (ch === '$') body += '$$';
        else if (ch === q) body += '$' + q;
        else if (isControl(ch)) body += controlEscape(ch, wide ? 4 : 2);
        else body += ch;
    }
    return q + body + q;
}

/**
 * Whether a character is a control character or a line/paragraph separator (anything that could
 * break a line or hide text in a dialog or a log).
 * @param {string} ch One character.
 * @returns {boolean}
 */
function isControl(ch) {
    const n = ch.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029;
}

/**
 * The ST escape of a control character: `$N`, `$R`, `$T`, or `$` and its code in hex.
 * @param {string} ch
 * @param {number} digits Hex digits (2 for STRING, 4 for WSTRING).
 * @returns {string}
 */
function controlEscape(ch, digits) {
    if (ch === '\n') return '$N';
    if (ch === '\r') return '$R';
    if (ch === '\t') return '$T';
    return '$' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(digits, '0');
}

/**
 * Shortens a text to at most `max` characters, counted in code points so a surrogate pair is never
 * split, ending in `…` when it was cut.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function shorten(s, max) {
    if (s.length <= max) return s;
    const points = Array.from(s);
    return points.length > max ? points.slice(0, max - 1).join('') + '…' : s;
}

/**
 * The text of an inline box: the value, shortened.
 * @param {any} value
 * @param {any} [dataType]
 * @returns {string}
 */
function inlineText(value, dataType) {
    return shorten(formatValue(value, dataType), INLINE_MAX);
}

/**
 * A value as the write modal and the log show it: one line, at most `TEXT_MAX` characters.
 * @param {any} value
 * @param {any} [dataType]
 * @returns {string}
 */
function boundedText(value, dataType) {
    return shorten(oneLine(formatValue(value, dataType)), TEXT_MAX);
}

/**
 * A text with every control character (line breaks included) replaced by a visible escape, for a log
 * entry or a dialog line built from text that came from the PLC or the user.
 * @param {string} s
 * @returns {string}
 */
function oneLine(s) {
    let out = '';
    for (const ch of String(s)) out += isControl(ch) ? controlEscape(ch, 2) : ch;
    return out;
}

/**
 * The text the write box starts with: the current value in a form `parseInput` reads back.
 * @param {any} value
 * @param {any} dataType
 * @returns {string}
 */
function editText(value, dataType) {
    if (value && typeof value === 'object' && 'name' in value && 'value' in value) return String(value.name);
    if (typeof value === 'string') return value;
    return formatValue(value, dataType);
}

/**
 * Parses what the user typed into a value for a scalar of `dataType`, or explains why not.
 * @param {string} text
 * @param {any} dataType An ads-client `AdsDataType`.
 * @returns {{ok: true, value: any, text: string}|{ok: false, error: string}}
 */
function parseInput(text, dataType) {
    if (!isScalar(dataType)) return { ok: false, error: 'Only single values can be written, not structures, FB instances or arrays.' };
    const raw = String(text === undefined || text === null ? '' : text).trim();
    const base = baseTypeName(dataType);
    if (isEnum(dataType)) {
        const byName = dataType.enumInfos.find((/** @type {any} */ e) => String(e.name).toLowerCase() === raw.replace(/^.*\./, '').toLowerCase());
        if (byName) return { ok: true, value: byName.name, text: String(byName.name) };
        if (/^-?\d+$/.test(raw)) {
            const byValue = dataType.enumInfos.find((/** @type {any} */ e) => String(e.value) === raw);
            if (byValue) return { ok: true, value: byValue.name, text: String(byValue.name) };
        }
        return { ok: false, error: `Not a value of ${dataType.name || base}: use one of ${dataType.enumInfos.map((/** @type {any} */ e) => e.name).join(', ')}.` };
    }
    if (base === 'BOOL' || base === 'BIT') {
        if (/^(TRUE|1)$/i.test(raw)) return { ok: true, value: true, text: 'TRUE' };
        if (/^(FALSE|0)$/i.test(raw)) return { ok: true, value: false, text: 'FALSE' };
        return { ok: false, error: 'A BOOL takes TRUE or FALSE.' };
    }
    const range = /** @type {Record<string, bigint[]>} */ (INT_RANGES)[base];
    if (range) {
        const m = /^(?:[A-Z_]+#)?(16#[0-9A-F_]+|2#[01_]+|8#[0-7_]+|[+-]?\d[\d_]*)$/i.exec(raw);
        if (!m) return { ok: false, error: `${base} takes a whole number.` };
        let n;
        const lit = m[1].replace(/_/g, '');
        if (/^16#/i.test(lit)) n = BigInt('0x' + lit.slice(3));
        else if (/^2#/.test(lit)) n = BigInt('0b' + lit.slice(2));
        else if (/^8#/.test(lit)) n = BigInt('0o' + lit.slice(2));
        else n = BigInt(lit);
        if (n < range[0] || n > range[1]) return { ok: false, error: `${base} takes ${range[0]} to ${range[1]}.` };
        return { ok: true, value: BIG.has(base) ? n : Number(n), text: n.toString() };
    }
    if (base === 'REAL' || base === 'LREAL') {
        const lit = raw.replace(/^L?REAL#/i, '').replace(/_/g, '');
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(lit)) return { ok: false, error: `${base} takes a number such as 1.5.` };
        const v = Number(lit);
        if (base === 'REAL' && Math.abs(v) > 3.4028234663852886e38) return { ok: false, error: 'Out of range for REAL.' };
        return { ok: true, value: v, text: String(v) };
    }
    if (base === 'STRING' || base === 'WSTRING') {
        let v = raw;
        const q = base === 'WSTRING' ? '"' : "'";
        if (v.length >= 2 && v.startsWith(q) && v.endsWith(q)) v = v.slice(1, -1);
        const max = /\((\d+)\)/.exec(String(dataType.name || dataType.type || ''));
        const limit = max ? Number(max[1]) : (dataType.size ? (base === 'WSTRING' ? dataType.size / 2 : dataType.size) - 1 : 80);
        if (v.length > limit) return { ok: false, error: `Too long: this string holds ${limit} characters.` };
        return { ok: true, value: v, text: shorten(quoteString(v, base === 'WSTRING'), TEXT_MAX) };
    }
    return { ok: false, error: `Writing a ${dataType.name || base} is not supported; write it from XAE.` };
}

/**
 * Whether the online type matches the type the project declares, compared the way the PLC spells
 * types (spaces dropped, case folded, `STRING` = `STRING(80)`).
 * @param {string|null} localType The declared type, or null when unknown.
 * @param {string} onlineType The symbol's type from the PLC.
 * @returns {boolean|null} null when there is no local type to compare.
 */
function typesMatch(localType, onlineType) {
    if (!localType) return null;
    const norm = (/** @type {string} */ t) => String(t).replace(/\s+/g, '').toUpperCase()
        .replace(/^STRING$/, 'STRING(80)').replace(/^WSTRING$/, 'WSTRING(80)');
    return norm(localType) === norm(onlineType);
}

module.exports = { formatValue, inlineText, boundedText, oneLine, shorten, editText, parseInput, isScalar, isEnum, typesMatch, baseTypeName, INLINE_MAX, TEXT_MAX };
