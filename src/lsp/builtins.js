/**
 * @file builtins.js
 * @description Standard IEC 61131-3 / TwinCAT built-in symbols (functions, function blocks,
 * operators, constants) that are always in scope and must never be flagged as undeclared.
 */

// Standard elementary data types (IEC 61131-3 + TwinCAT extensions).
const STANDARD_TYPES = new Set([
    'BOOL', 'BIT',
    'BYTE', 'WORD', 'DWORD', 'LWORD',
    'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
    'REAL', 'LREAL',
    'TIME', 'LTIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
    'STRING', 'WSTRING', 'CHAR', 'WCHAR',
    'POINTER', 'REFERENCE', 'ARRAY',
    'ANY', 'ANY_INT', 'ANY_REAL', 'ANY_NUM', 'ANY_BIT', 'ANY_DATE', 'ANY_STRING',
    '__SYSTEM', 'XINT', 'UXINT', 'XWORD', 'PVOID', 'ITcUnknown'
]);

// Language keywords (control flow, declaration sections, structural terminators, operators-as-words).
const STANDARD_KEYWORDS = new Set([
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'RETURN', 'EXIT', 'CONTINUE', 'JMP',
    'TRUE', 'FALSE', 'NULL',
    'VAR', 'END_VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT',
    'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_EXTERNAL', 'VAR_INST', 'VAR_CONFIG',
    'CONSTANT', 'RETAIN', 'PERSISTENT', 'AT',
    'PROGRAM', 'END_PROGRAM',
    'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
    'FUNCTION', 'END_FUNCTION',
    'INTERFACE', 'END_INTERFACE', 'IMPLEMENTS', 'EXTENDS', 'GVL',
    'METHOD', 'END_METHOD',
    'PROPERTY', 'END_PROPERTY',
    'GET', 'END_GET', 'SET', 'END_SET',
    'ACTION', 'END_ACTION',
    'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'UNION', 'END_UNION',
    'POINTER', 'REFERENCE', 'ARRAY',
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    'AND_THEN', 'OR_ELSE',
    'THIS', 'SUPER', 'ABSTRACT', 'FINAL', 'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL',
    'OVERRIDE'
]);

// Standard functions and function blocks (always in scope).
const STANDARD_FUNCTIONS = new Set([
    // Math
    'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2', 'EXPT',
    'TRUNC', 'TRUNC_INT', 'FRACTIONAL',
    // Selection / comparison
    'MIN', 'MAX', 'LIMIT', 'MUX', 'SEL', 'MOVE',
    // Bit / shift
    'SHL', 'SHR', 'ROL', 'ROR',
    // String
    'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
    'WLEN', 'WLEFT', 'WRIGHT', 'WMID', 'WCONCAT', 'WINSERT', 'WDELETE', 'WREPLACE', 'WFIND',
    // Memory / pointer
    'ADR', 'BITADR', 'SIZEOF', 'XSIZEOF', 'REF', '__NEW', '__DELETE', 'MEMSET', 'MEMCPY', 'MEMMOVE', 'MEMCMP',
    '__ISVALIDREF', '__QUERYINTERFACE', '__QUERYPOINTER', '__VARINFO', '__POUNAME',
    // Standard function blocks (timers/counters/edges/bistables)
    'TON', 'TOF', 'TP', 'RTC',
    'CTU', 'CTD', 'CTUD', 'CTU_DINT', 'CTD_DINT', 'CTUD_DINT',
    'R_TRIG', 'F_TRIG', 'RS', 'SR', 'SEMA',
    'BLINK', 'GEN', 'FT_ON', 'FT_OFF',
    // TwinCAT system
    'F_GetVersionTcSystem', 'GETCURTASKINDEX', 'GETCURTASKINDEXEX',
    'LogicalToPhysicalAddress', 'TestAndSet'
]);

/**
 * Returns true if the identifier is a standard type-conversion function,
 * e.g. INT_TO_BYTE, REAL_TO_DINT, TO_STRING, WORD_TO_BOOL, TIME_TO_DINT.
 * @param {string} name Identifier text.
 * @returns {boolean}
 */
function isConversionFunction(name) {
    const upper = name.toUpperCase();
    // <TYPE>_TO_<TYPE> or TO_<TYPE> (TwinCAT shorthand) or TRUNC_<TYPE>.
    if (/^[A-Z_]+_TO_[A-Z_]+$/.test(upper)) return true;
    if (/^TO_[A-Z_]+$/.test(upper)) return true;
    return false;
}

/**
 * Returns true if the identifier is any known built-in (keyword, type, function, FB, or conversion).
 * @param {string} name Identifier text.
 * @returns {boolean}
 */
function isBuiltin(name) {
    if (!name) return false;
    const upper = name.toUpperCase();
    return STANDARD_KEYWORDS.has(upper)
        || STANDARD_TYPES.has(upper)
        || STANDARD_FUNCTIONS.has(upper)
        || isConversionFunction(name);
}

module.exports = {
    STANDARD_TYPES,
    STANDARD_KEYWORDS,
    STANDARD_FUNCTIONS,
    isConversionFunction,
    isBuiltin
};
