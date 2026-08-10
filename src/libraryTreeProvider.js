/**
 * @file libraryTreeProvider.js
 * @description TreeDataProvider for the "TwinCAT Libraries" view: the libraries the project's
 * .plcproj references, each shown under the **namespace** the code has to use.
 *
 * Why the namespace is the label and not the library name: they are routinely different strings, and
 * only the namespace is typeable. The .plcproj says
 *
 *     <PlaceholderReference Include="Balluff BVS Sensor">
 *       <DefaultResolution>Balluff Sesnor Library TC3, * (Balluff GmbH)</DefaultResolution>
 *       <Namespace>Balluff_BVS_Sensor</Namespace>
 *
 * — three names for one library, and `Balluff_BVS_Sensor.` is the only one the compiler answers to.
 * Surfacing that mapping is the entire point of the view; the types beneath each library are a bonus
 * for the libraries the project already uses.
 *
 * The catalog itself is owned by the LSP process (src/lsp/libsymbols.js, `custom/libraries`): it falls
 * out of an index that costs ~32k symbols and ~50 MB of archive reads, so the extension host asks for
 * it over the wire instead of building a second copy. This provider therefore never requires the lsp
 * modules — it is handed a `sendRequest` closure and knows nothing else about the client.
 */

const vscode = require('vscode');
// The call formatter is shared with the "TwinCAT Objects" explorer's Insert commands, so it lives in
// a vscode-free module: this file cannot be loaded outside a VS Code host, and the two views must
// lay a parameter list out identically.
const { orderedParams, callTemplate } = require('./insertTemplates');

/** Type kind (from the `.tmc` or the signatures dump) → the codicon that reads as that kind in VS Code. */
const TYPE_ICONS = {
    fb: 'symbol-class',
    function: 'symbol-method',
    interface: 'symbol-interface',
    struct: 'symbol-structure',
    enum: 'symbol-enum',
    gvl: 'symbol-namespace'
};

/**
 * The groups a library's types are bucketed into, in display order.
 *
 * A library can now carry hundreds of types (the signatures dump gives every FB and function of every
 * referenced library, not just the handful the `.tmc` exports), so a single flat alphabetical list is
 * unreadable — `FB_Array` sorts next to `F_Concat` next to `ST_Foo`. Grouping by kind is what makes it
 * browsable: you almost always know whether you are looking for a function block or a data type.
 *
 * Kinds not listed here fall into the last bucket, so a new kind can never silently vanish from the tree.
 */
const TYPE_GROUPS = [
    { kind: 'fb', label: 'Function Blocks', icon: 'symbol-class' },
    { kind: 'function', label: 'Functions', icon: 'symbol-method' },
    { kind: 'interface', label: 'Interfaces', icon: 'symbol-interface' },
    { kind: 'struct', label: 'Structures', icon: 'symbol-structure' },
    { kind: 'enum', label: 'Enumerations', icon: 'symbol-enum' },
    { kind: 'gvl', label: 'GVLs', icon: 'symbol-namespace' },
    { kind: 'opaque', label: 'Data Types', icon: 'symbol-misc' }
];

/**
 * The text to insert into the editor for a tree node — the whole point of "Insert at Cursor".
 *
 * A library inserts `Namespace.` **with** the trailing dot: namespace-qualified completion already
 * works, so landing the caret right after the dot is what makes the library's contents browsable
 * from the keyboard. A type inserts its fully qualified name; a member inserts its bare name (it is
 * only ever written after an instance, which the user already typed).
 * @param {Object} node A tree node from this provider.
 * @returns {string} Text to insert, or '' when the node is not insertable.
 */
function insertTextForNode(node) {
    if (!node) return '';
    if (node.kind === 'library') return `${node.entry.namespace}.`;
    if (node.kind === 'type') return `${node.namespace}.${node.type.name}`;
    if (node.kind === 'member') {
        // An enum value or a GVL global is written namespace-qualified (`Namespace.E_Foo.Value`,
        // `Namespace.GVL_X.gVar`) — that is a complete, insertable reference. A struct field or a call
        // parameter is written after an instance the user has already typed, so it stays a bare name.
        const owner = node.ownerType;
        if (owner && node.namespace && (owner.kind === 'enum' || owner.kind === 'gvl')) {
            return `${node.namespace}.${owner.name}.${node.member.name}`;
        }
        return node.member.name;
    }
    // A property (from the browsercache) inserts its bare name — written after an instance, like a field.
    if (node.kind === 'property') return node.property.name;
    // A method is only ever written after an instance (`mover.Halt(…)`), which the user has already
    // typed — so, like a member, it inserts its bare name and not a qualified one.
    if (node.kind === 'method') return node.method.name;
    return '';
}

/**
 * A ready-to-fill call template — the node's name with every parameter laid out, one per line, typed.
 *
 * This is what "Insert at Cursor" cannot be: that inserts a bare name, which is useless for an FB
 * with a dozen inputs you would then have to look up one at a time.
 *
 * A **type** gives its own call parameters (an FB's VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT); a
 * **method** gives its parameters and is inserted bare, because it is written after an instance the
 * user has already typed. Anything with no parameters at all — a struct, an enum, an alias — has no
 * template to give and falls back to the name, the same thing Insert at Cursor would produce.
 * @param {Object} node A tree node from this provider.
 * @returns {string} Text to insert, or '' when the node is not insertable.
 */
function formattedDefinitionForNode(node) {
    if (!node) return '';

    if (node.kind === 'type') {
        const qualified = node.namespace ? `${node.namespace}.${node.type.name}` : node.type.name;
        // orderedParams keeps only nameable parameters, inputs first, then in-outs, then outputs.
        const params = orderedParams(node.type.members);
        return params.length ? callTemplate(qualified, params) : qualified;
    }

    if (node.kind === 'method') {
        // Qualified with the function block that owns it — `FB_List.Add(…)`. Strictly, ST calls a
        // method on an *instance* (`fbList.Add(…)`), not on the type, so the prefix is something the
        // user replaces. Naming the owner is still the point: a bare `Add(` at a cursor says nothing
        // about what it belongs to or where it came from.
        const owner = node.namespace ? `${node.namespace}.${node.owner.name}` : node.owner.name;
        const params = orderedParams(node.method.params);
        return params.length ? callTemplate(`${owner}.${node.method.name}`, params) : `${owner}.${node.method.name}();`;
    }

    return insertTextForNode(node);
}

class TwinCatLibraryTreeDataProvider {
    /**
     * @param {(method: string, params?: Object) => Thenable<any>} sendRequest Sends a custom request
     *        to the LSP. extension.js owns the client handle and passes a closure over it, so this
     *        module never imports it.
     */
    constructor(sendRequest) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.sendRequest = sendRequest;
        /** Cached catalog; null until the first fetch, and dropped by refresh(). @type {Array<Object>|null} */
        this.catalog = null;
    }

    /** Drops the cached catalog and re-renders (the next getChildren() re-fetches it). */
    refresh() {
        this.catalog = null;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Fetches the catalog once and caches it. An LSP that is not up yet, or a request that fails, is
     * not an error the user should see: the view simply stays empty (its viewsWelcome message then
     * explains what is missing) and the Explorer keeps working.
     * @returns {Promise<Array<Object>>} Catalog entries, or [] when unavailable.
     */
    async getCatalog() {
        if (this.catalog) return this.catalog;
        try {
            const result = await this.sendRequest('custom/libraries');
            this.catalog = Array.isArray(result) ? result : [];
        } catch (e) {
            this.catalog = [];
        }
        return this.catalog;
    }

    async getChildren(element) {
        if (!element) {
            const catalog = await this.getCatalog();
            return catalog.map(entry => ({ kind: 'library', entry }));
        }

        if (element.kind === 'library') {
            const types = element.entry.types || [];
            // A library with no types means the project never generated signatures and the `.tmc` does
            // not cover it. An empty expandable node reads as a bug, so say why instead. The raw
            // string-table names are deliberately NOT offered here: for Tc2_MC2 that is 2,161 entries
            // mixing real types with internal member names — browsable noise, not a type list.
            if (types.length === 0) return [{ kind: 'empty' }];

            // Bucket by kind. Anything with an unrecognised kind lands in the final group rather than
            // disappearing, so adding a kind upstream can never silently hide types.
            const known = new Set(TYPE_GROUPS.map(g => g.kind));
            const last = TYPE_GROUPS[TYPE_GROUPS.length - 1].kind;
            const buckets = new Map();
            for (const type of types) {
                const bucket = known.has(type.kind) ? type.kind : last;
                if (!buckets.has(bucket)) buckets.set(bucket, []);
                buckets.get(bucket).push(type);
            }

            return TYPE_GROUPS
                .filter(group => buckets.has(group.kind))     // never show an empty group
                .map(group => ({
                    kind: 'group',
                    group,
                    namespace: element.entry.namespace,
                    types: buckets.get(group.kind)
                }));
        }

        if (element.kind === 'group') {
            return element.types
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(type => ({ kind: 'type', namespace: element.namespace, type }));
        }

        if (element.kind === 'type') {
            // Fields/parameters, then methods, then properties — a reader looks for an FB's inputs
            // before its methods, and an FB like FB_XmlDomParser has 103 of the latter. Methods and
            // properties come from the `.tmc` (with parameters) and the browsercache (names only).
            // ownerType/namespace ride along so an enum value or GVL global can be inserted qualified.
            return [
                ...(element.type.members || []).map(member =>
                    ({ kind: 'member', member, ownerType: element.type, namespace: element.namespace })),
                ...(element.type.methods || [])
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(method => ({ kind: 'method', method, owner: element.type, namespace: element.namespace })),
                ...(element.type.properties || [])
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(property => ({ kind: 'property', property, owner: element.type, namespace: element.namespace }))
            ];
        }

        if (element.kind === 'method') {
            return (element.method.params || []).map(member => ({ kind: 'member', member }));
        }

        return [];
    }

    getTreeItem(element) {
        if (element.kind === 'library') {
            return this.libraryItem(element.entry);
        }

        if (element.kind === 'group') {
            const item = new vscode.TreeItem(element.group.label, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = String(element.types.length);
            item.iconPath = new vscode.ThemeIcon(element.group.icon);
            // Deliberately not 'twincatLibraryType': a group is a heading, so it gets no Insert at
            // Cursor / Copy Qualified Name (there is nothing to insert).
            item.contextValue = 'twincatLibraryGroup';
            return item;
        }

        if (element.kind === 'type') {
            const type = element.type;
            // Methods count as children too. Counting only members made every *interface* a leaf —
            // I_List has 21 methods and no fields, so its whole surface was unreachable, along with
            // 127 other methods across the catalog.
            const hasChildren = (type.members || []).length > 0
                || (type.methods || []).length > 0 || (type.properties || []).length > 0;
            const item = new vscode.TreeItem(
                type.name,
                hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );
            // The group heading already says what kind this is, so spend the description on something
            // it does not: a function's return type, or — for a GVL we can list no globals for — a note
            // that it is empty by data-availability, not by failure (see the tooltip). Others get nothing.
            const emptyGvl = type.kind === 'gvl' && !hasChildren;
            item.description = type.kind === 'function' && type.returnType ? `: ${type.returnType}`
                : (emptyGvl ? 'no exported globals' : '');
            item.iconPath = new vscode.ThemeIcon(TYPE_ICONS[type.kind] || 'symbol-misc');
            item.tooltip = emptyGvl
                ? `${element.namespace}.${type.name}\n\nTwinCAT's signature export lists only VAR_GLOBAL `
                  + `CONSTANT, so a GVL of non-constant globals has no members to show. The name is still `
                  + `usable — insert it and type \`${type.name}.\` to reference a global.`
                : `${element.namespace}.${type.name}`;
            item.contextValue = 'twincatLibraryType';
            return item;
        }

        if (element.kind === 'method') {
            const method = element.method;
            // A `.tmc` method has a params array (its signature is known); a browsercache method has
            // none (params unknown). Only the former expands and shows a signature — the latter is a
            // bare name, which is honest about what the browsercache carries.
            const knownParams = Array.isArray(method.params);
            const params = method.params || [];
            const item = new vscode.TreeItem(
                method.name,
                params.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );
            const sig = params.map(p => p.name).join(', ');
            item.description = knownParams ? `(${sig})${method.returnType ? ` : ${method.returnType}` : ''}` : '';
            item.iconPath = new vscode.ThemeIcon('symbol-method');
            item.tooltip = `${element.owner.name}.${method.name}`;
            item.contextValue = 'twincatLibraryMethod';
            return item;
        }

        if (element.kind === 'property') {
            // Names only (from the browsercache) — a leaf, inserted as a bare name like a member (it is
            // written after an instance the user has already typed: `fbAxis.Enabled`).
            const item = new vscode.TreeItem(element.property.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-property');
            item.tooltip = `${element.owner.name}.${element.property.name}`;
            item.contextValue = 'twincatLibraryMember';
            return item;
        }

        if (element.kind === 'member') {
            const member = element.member;
            const item = new vscode.TreeItem(member.name, vscode.TreeItemCollapsibleState.None);
            // 'VAR_INPUT · BOOL' for a call parameter, plain 'BOOL' for a struct field (no scope).
            item.description = [member.scope, member.type].filter(Boolean).join(' · ');
            item.iconPath = new vscode.ThemeIcon('symbol-field');
            item.contextValue = 'twincatLibraryMember';
            return item;
        }

        // 'empty' — a library we know the namespace of but have no structured types for.
        const item = new vscode.TreeItem('No indexed types', vscode.TreeItemCollapsibleState.None);
        item.description = 'not used by this project, or binary-only';
        item.contextValue = 'twincatLibraryEmpty';
        return item;
    }

    /**
     * Builds the top-level item for one library. The label is the namespace (what the programmer
     * types); the library's real title, version and vendor go in the description, where they identify
     * the library without competing with the name that matters.
     * @param {Object} entry Catalog entry from the LSP.
     * @returns {vscode.TreeItem}
     */
    libraryItem(entry) {
        const item = new vscode.TreeItem(entry.namespace, vscode.TreeItemCollapsibleState.Collapsed);
        const titled = [entry.title, entry.version].filter(Boolean).join(' ');
        item.description = entry.company ? `${titled} · ${entry.company}` : titled;
        item.iconPath = new vscode.ThemeIcon('library');

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Namespace:** \`${entry.namespace}\`\n\n`);
        md.appendMarkdown(`**Library:** ${entry.title}\n\n`);
        if (entry.version) md.appendMarkdown(`**Version:** ${entry.version}\n\n`);
        if (entry.company) md.appendMarkdown(`**Company:** ${entry.company}\n\n`);
        // Only worth showing when it is a *third* string — the placeholder name the project resolves
        // through, which is exactly the case this view exists to make visible.
        if (entry.include && entry.include !== entry.title) {
            md.appendMarkdown(`**${entry.kind === 'placeholder' ? 'Placeholder' : 'Reference'}:** ${entry.include}\n\n`);
        }
        md.appendMarkdown(`_Use as:_ \`${entry.namespace}.Symbol\``);
        item.tooltip = md;

        item.contextValue = 'twincatLibrary';
        return item;
    }
}

module.exports = { TwinCatLibraryTreeDataProvider, insertTextForNode, formattedDefinitionForNode };
