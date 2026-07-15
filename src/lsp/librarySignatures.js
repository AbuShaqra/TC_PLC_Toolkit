'use strict';

/**
 * Parser for the XML that TwinCAT's `ITcPlcLibraryManager2.ProduceAllLibrarySignatures()` emits — a
 * per-library dump of every exported Function, FunctionBlock, Type, VarGlobal and Interface.
 *
 * Why this exists (and what it is NOT). Library structure has two disjoint sources, and this is the
 * second of them — it does not replace the first:
 *   - the project `.tmc` (see libsymbols.js `parseTmcDataType`) gives struct FIELDS and enum VALUES,
 *     but only for the ~354 types the project already uses, and no functions or constants at all;
 *   - these signatures give FUNCTION parameter/return signatures, FB input/output signatures and
 *     global-constant names for EVERY referenced library — but carry no struct fields or enum values
 *     (a `type="Type"` entry is a bare name), and no FB methods.
 * So the two are merged, `.tmc` winning wherever it has members. This module is the pure XML→structure
 * step; the merge into the workspace type registry lives in libsymbols.js `indexLibrarySignatures`.
 *
 * The signatures XML is produced on a machine that has TwinCAT (the generator), then shipped/cached as
 * JSON so the extension itself stays fully offline. Parsing is regex-based to match the rest of the
 * codebase (xmlParser.js, libsymbols.js), which deliberately avoids a DOM dependency.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Members a nameable call argument can bind to, mirroring libsymbols.js `ITEM_TYPE_SCOPE`. */
const SCOPE = { input: 'VAR_INPUT', output: 'VAR_OUTPUT', inout: 'VAR_IN_OUT' };

/** Pulls `<Section><Inner>…</Inner>…</Section>` variable rows into `{name, type, scope}` records. */
function parseVars(block, section, inner, scope) {
    const sec = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(block);
    if (!sec) return [];
    const rows = [];
    const re = new RegExp(`<${inner}>([\\s\\S]*?)</${inner}>`, 'g');
    let m;
    while ((m = re.exec(sec[1])) !== null) {
        const body = m[1];
        const nameM = /<Name>([^<]*)<\/Name>/.exec(body);
        if (!nameM) continue;
        const name = nameM[1].trim();
        if (!IDENTIFIER.test(name)) continue;
        const typeM = /<DataType>([^<]*)<\/DataType>/.exec(body);
        rows.push({ name, type: typeM ? typeM[1].trim() : '', scope });
    }
    return rows;
}

/**
 * Parses a ProduceAllLibrarySignatures XML string.
 * @param {string} xml
 * @returns {{libraries: Array<{name:string, version:string, distributor:string,
 *   functions:Array, functionBlocks:Array, types:string[], globals:Array, interfaces:string[]}>}}
 */
function parseLibrarySignaturesXml(xml) {
    const libraries = [];
    if (!xml || typeof xml !== 'string') return { libraries };

    const libRe = /<Library>([\s\S]*?)<\/Library>/g;
    let libM;
    while ((libM = libRe.exec(xml)) !== null) {
        const libBody = libM[1];
        const name = (/<LibraryName>([^<]*)<\/LibraryName>/.exec(libBody) || [, ''])[1].trim();
        const version = (/<Version>([^<]*)<\/Version>/.exec(libBody) || [, ''])[1].trim();
        const distributor = (/<Distributor>([^<]*)<\/Distributor>/.exec(libBody) || [, ''])[1].trim();

        const lib = { name, version, distributor, functions: [], functionBlocks: [], types: [], globals: [], interfaces: [] };

        const sigRe = /<TypeSignature type="([^"]+)">([\s\S]*?)<\/TypeSignature>/g;
        let sigM;
        while ((sigM = sigRe.exec(libBody)) !== null) {
            const kind = sigM[1];
            const body = sigM[2];
            const nm = (/<Name>([^<]*)<\/Name>/.exec(body) || [, ''])[1].trim();
            if (!IDENTIFIER.test(nm)) continue;

            if (kind === 'Function') {
                const outputs = parseVars(body, 'Outputs', 'Output', SCOPE.output);
                lib.functions.push({
                    name: nm,
                    inputs: parseVars(body, 'Inputs', 'Input', SCOPE.input),
                    inouts: parseVars(body, 'InOuts', 'InOut', SCOPE.inout),
                    // A function's return value is emitted as its single like-named Output.
                    returnType: outputs.length ? outputs[0].type : ''
                });
            } else if (kind === 'FunctionBlock') {
                lib.functionBlocks.push({
                    name: nm,
                    inputs: parseVars(body, 'Inputs', 'Input', SCOPE.input),
                    outputs: parseVars(body, 'Outputs', 'Output', SCOPE.output),
                    inouts: parseVars(body, 'InOuts', 'InOut', SCOPE.inout)
                });
            } else if (kind === 'VarGlobal') {
                const constants = parseVars(body, 'Constants', 'Constant', '');
                lib.globals.push({ name: nm, constants });
            } else if (kind === 'Interface') {
                lib.interfaces.push(nm);
            } else { // "Type" (struct/enum/alias) — name only; no members are exported here.
                lib.types.push(nm);
            }
        }
        libraries.push(lib);
    }
    return { libraries };
}

/**
 * Flattens parsed libraries into registry-ready type records, shaped like libsymbols.js
 * `parseTmcDataType` output so they merge into the same `typeSystemTypes` store.
 *
 * `kind` extends the `.tmc` set with `'function'` (a callable with a `returnType`); FBs are `'fb'`
 * with scoped input/output members, and Type/Interface are `'opaque'` (name only). Global constants
 * are returned separately as bare names — they are symbols, not types.
 *
 * @param {ReturnType<typeof parseLibrarySignaturesXml>} parsed
 * @returns {{types: Array<{name,kind,namespace,members,returnType?}>, symbols: string[]}}
 */
function toRegistryTypes(parsed) {
    const types = [];
    const symbols = [];
    for (const lib of parsed.libraries) {
        const ns = lib.name;
        for (const fb of lib.functionBlocks) {
            types.push({ name: fb.name, kind: 'fb', namespace: ns, source: 'sig',
                members: [...fb.inputs, ...fb.outputs, ...fb.inouts] });
        }
        for (const fn of lib.functions) {
            types.push({ name: fn.name, kind: 'function', namespace: ns, source: 'sig',
                returnType: fn.returnType || '', members: [...fn.inputs, ...fn.inouts] });
        }
        for (const t of lib.types) types.push({ name: t, kind: 'opaque', namespace: ns, source: 'sig', members: [] });
        for (const itf of lib.interfaces) types.push({ name: itf, kind: 'opaque', namespace: ns, source: 'sig', members: [] });
        for (const g of lib.globals) {
            symbols.push(g.name);
            for (const c of g.constants) symbols.push(c.name);
        }
    }
    return { types, symbols };
}

module.exports = { parseLibrarySignaturesXml, toRegistryTypes };
