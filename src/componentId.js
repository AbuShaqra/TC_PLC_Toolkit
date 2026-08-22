/**
 * @file componentId.js
 * @description The single owner of the component-id string grammar (`root`, `method_X`,
 * `prop_X`, `prop_X_get`, `prop_X_set`, `action_X`, `transition_X`) shared by the webview,
 * the extension host and the LSP server. vscode-free so all three can require it.
 *
 * The grammar is FROZEN: ids travel over the LSP bridge and into saved workbench state, so
 * this module reproduces exactly what xmlParser.js has always minted — byte for byte.
 * Deliberate ambiguity, pinned here because every consumer already resolved it this way:
 * `prop_X_get` parses as the Get accessor of property X, never as a property named `X_get`.
 */

/** Component kinds, in minted spelling. `root` has no name; only `prop` takes an accessor. */
const KINDS = Object.freeze(['root', 'method', 'prop', 'action', 'transition']);

/** Kind → the TwinCAT XML tag that holds that component (root and accessors excluded). */
const KIND_TO_XML_TAG = Object.freeze({
    method: 'Method', prop: 'Property', action: 'Action', transition: 'Transition'
});

const ACCESSOR_RE = /^prop_(.+)_(get|set)$/;
const KIND_RE = /^(method|prop|action|transition)_(.+)$/;

/**
 * Builds a component id. Throws on invalid combinations — bad input here is a programmer
 * error, not user data.
 * @param {'root'|'method'|'prop'|'action'|'transition'} kind
 * @param {string} [name] Required for every kind except 'root'.
 * @param {'get'|'set'|null} [accessor] Only valid with kind 'prop'.
 * @returns {string}
 */
function make(kind, name, accessor) {
    if (!KINDS.includes(kind)) throw new Error(`componentId.make: unknown kind '${kind}'`);
    if (kind === 'root') return 'root';
    if (!name) throw new Error('componentId.make: name is required');
    if (accessor) {
        if (kind !== 'prop') throw new Error('componentId.make: accessor is only valid on prop');
        if (accessor !== 'get' && accessor !== 'set') {
            throw new Error(`componentId.make: unknown accessor '${accessor}'`);
        }
        return `prop_${name}_${accessor}`;
    }
    return `${kind}_${name}`;
}

/**
 * Parses a component id. Returns null for anything outside the grammar (matching is
 * case-sensitive: mint sites always produce lowercase prefixes).
 * @param {string|null|undefined} id
 * @returns {{kind: string, name: string|null, accessor: string|null}|null}
 */
function parse(id) {
    if (typeof id !== 'string' || id === '') return null;
    if (id === 'root') return { kind: 'root', name: null, accessor: null };
    const acc = ACCESSOR_RE.exec(id);
    if (acc) return { kind: 'prop', name: acc[1], accessor: acc[2] };
    const m = KIND_RE.exec(id);
    if (m) return { kind: m[1], name: m[2], accessor: null };
    return null;
}

/** @param {string|null|undefined} id @returns {boolean} True for a Get/Set accessor id. */
function isAccessor(id) {
    const p = parse(id);
    return !!(p && p.accessor);
}

/**
 * Display label: 'Main' for root/empty, `name()` for a method, the property name for a
 * property or its accessor, the bare name otherwise. Unknown ids pass through unchanged
 * (the References view's long-standing fallback).
 * @param {string|null|undefined} id @returns {string}
 */
function label(id) {
    if (!id || id === 'root') return 'Main';
    const p = parse(id);
    if (!p) return id;
    if (p.kind === 'method') return `${p.name}()`;
    return p.name;
}

/**
 * The member segment used in synthetic peek-model paths: `root` for the root panes,
 * `Name_get`/`Name_set` for accessors (today's path shape, preserved), the bare name
 * otherwise. Unknown ids pass through unchanged.
 * @param {string|null|undefined} id @returns {string}
 */
function memberName(id) {
    if (!id || id === 'root') return 'root';
    const p = parse(id);
    if (!p) return id;
    if (p.accessor) return `${p.name}_${p.accessor}`;
    return p.name;
}

/**
 * The Get/Set accessor ids of a property SIGNATURE id, by suffix concatenation.
 *
 * Concatenation is deliberate and load-bearing: it reproduces xmlParser's mint exactly
 * (`prop_${name}` + `_get`) and is immune to the grammar's accessor ambiguity — parsing a
 * property named `Foo_get` misreads it as an accessor of Foo, which is how the Objects tree
 * once recursed infinitely. Callers must pass the property's own id, not an accessor id.
 * @param {string} propertyId A `prop_<name>` id as minted for the property signature.
 * @returns {{get: string, set: string}}
 */
function accessorIdsFor(propertyId) {
    if (typeof propertyId !== 'string' || !/^prop_.+/.test(propertyId)) {
        throw new Error(`componentId.accessorIdsFor: not a prop signature id: '${propertyId}'`);
    }
    return { get: `${propertyId}_get`, set: `${propertyId}_set` };
}

module.exports = { KINDS, KIND_TO_XML_TAG, make, parse, isAccessor, label, memberName, accessorIdsFor };
