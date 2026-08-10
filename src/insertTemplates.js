/**
 * @file insertTemplates.js
 * @description The text "Insert at Cursor" and "Insert Definition at Cursor" put into the editor —
 * for both the "TwinCAT Libraries" view and the "TwinCAT Objects" explorer.
 *
 * The call formatter started life inside src/libraryTreeProvider.js, which requires `vscode` at
 * module scope. That made it unreachable from the Objects-tree commands' pure half and from any
 * standalone harness, so it moved here unchanged: this module has no dependencies at all, and the
 * library provider now requires it back. Both views therefore lay a call out identically — a
 * parameter list that looked one way from the Libraries view and another from the Objects tree would
 * read as two features.
 *
 * Pure functions only, deliberately (the same split as src/dndRules.js and src/objectKinds.js):
 * everything here is driven from a symbol node, so test/test_object_insert.js can drive it over real
 * objects from sample/ without a VS Code host.
 */

/** The member scopes that are nameable call parameters (everything else is an internal field). */
const PARAM_SCOPES = { VAR_INPUT: 0, VAR_IN_OUT: 1, VAR_OUTPUT: 2 };

/**
 * Keeps only the members that can be named at a call site, in the order they are written there.
 *
 * The filter is the load-bearing half: a POU's plain `VAR` is a local, and offering it as an
 * argument would produce a template that does not compile.
 * @param {Array<Object>|undefined|null} list Members/variables carrying a `scope`.
 * @returns {Array<Object>} Call parameters, inputs first, then in-outs, then outputs.
 */
function orderedParams(list) {
    return (list || [])
        .filter(p => p.scope in PARAM_SCOPES)
        .sort((a, b) => PARAM_SCOPES[a.scope] - PARAM_SCOPES[b.scope]);
}

/**
 * Lays out a call's parameter list, one per line, name-aligned and typed. Inputs and in-outs bind
 * with `:=`, outputs with `=>` — the distinction TwinCAT enforces at a call site.
 * @param {string} callee Text before the '(' — a qualified type name, or a bare method name.
 * @param {Array<Object>} params Parameters, already in the order they should be written.
 * @returns {string} The call template.
 */
function callTemplate(callee, params) {
    const width = params.reduce((n, p) => Math.max(n, p.name.length), 0);
    const lines = params.map((p, i) => {
        const assign = p.scope === 'VAR_OUTPUT' ? '=>' : ':=';
        const comma = i < params.length - 1 ? ',' : '';
        const pad = ' '.repeat(width - p.name.length);
        const comment = p.type ? `  // ${p.type}` : '';
        return `    ${p.name}${pad} ${assign} ${comma}${comment}`;
    });
    return `${callee}(\n${lines.join('\n')}\n);`;
}

/**
 * Derives an instance name from a function block's TYPE name.
 *
 * ST calls an *instance*, never the type: `FB_Clamping(bExecute := ...)` is not valid code, and
 * inserting it would hand the user a snippet they have to restructure rather than fill in. So the
 * template is written against `fbClamping`, which the user is expected to replace with their real
 * instance — the same "the prefix is yours to fix" contract the Libraries view already documents for
 * methods. The leading `FB_` is stripped first so the result reads as camelCase rather than
 * `fbFB_Clamping`.
 * @param {string} typeName The function block's type name.
 * @returns {string} A plausible instance name for it.
 */
function instanceNameForFb(typeName) {
    const base = (typeName || '').replace(/^fb_/i, '');
    return `fb${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

/**
 * The bare name to insert for an Objects-tree node — what "Insert at Cursor" writes.
 *
 * This exists because the tree's label is not the symbol: a file row is labelled with the FILE name
 * (`FB_Clamping.TcPOU`), so the object's real name has to come from the parsed node. A member row's
 * label *is* the symbol, and is passed in.
 * @param {Object|null} node The symbol node built from the object's XML (src/lsp/xmlIndexer.js).
 * @param {string|null} memberName Method/property/action name when a member row was clicked.
 * @returns {string} Text to insert, or '' when there is nothing to insert.
 */
function objectInsertText(node, memberName) {
    if (memberName) return memberName;
    return (node && node.name) || '';
}

/**
 * A ready-to-fill call/usage snippet for an Objects-tree node — what "Insert Definition at Cursor"
 * writes. The bare name is no use for an FB with a dozen inputs you would then look up one at a time.
 *
 * The callee depends on the kind, because ST does not call all of them the same way:
 *   - **FUNCTION_BLOCK** → a derived instance name (see {@link instanceNameForFb});
 *   - **FUNCTION** / **PROGRAM** → their own name, which is what a call site writes;
 *   - a **member** (method or action) → its bare name, because the instance prefix is whatever the
 *     user has already typed at the caret;
 *   - anything with no call site at all (interface, GVL, DUT) → the bare name. The menu does not
 *     offer this command on those, but inventing `GVL_System()` if it ever did would be worse.
 *
 * With no parameters the template collapses to `Callee();` rather than to a bare word: a call with
 * no arguments is still a call, and the bare name is exactly what the other command already gives.
 * @param {Object|null} node The symbol node built from the object's XML (src/lsp/xmlIndexer.js).
 * @param {string|null} memberName Method/action name when a member row was clicked.
 * @returns {string} Text to insert, or '' when there is nothing to insert.
 */
function objectDefinitionText(node, memberName) {
    if (!node) return '';

    if (memberName) {
        // An ACTION has no parameters at all, and is not in `methods` — it falls through to `Name();`.
        const method = (node.methods || []).find(m => m.name && m.name.toLowerCase() === memberName.toLowerCase());
        const params = method ? orderedParams(method.variables) : [];
        return params.length ? callTemplate(memberName, params) : `${memberName}();`;
    }

    let callee;
    if (node.type === 'FUNCTION_BLOCK') callee = instanceNameForFb(node.name);
    else if (node.type === 'FUNCTION' || node.type === 'PROGRAM') callee = node.name;
    else return objectInsertText(node, null);

    const params = orderedParams(node.variables);
    return params.length ? callTemplate(callee, params) : `${callee}();`;
}

module.exports = {
    PARAM_SCOPES,
    orderedParams,
    callTemplate,
    instanceNameForFb,
    objectInsertText,
    objectDefinitionText
};
