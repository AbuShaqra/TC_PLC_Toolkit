/**
 * @file fetch-pragma-catalog.js
 * @description Regenerates `src/lsp/pragmaCatalog.json` from the Beckhoff Infosys documentation.
 *
 * **Run deliberately, by hand — never at runtime.** The extension and its webview must work with no
 * network at all (see CLAUDE.md, "The webview must stay fully offline"), so the catalog ships as
 * committed data. This script is the only thing that ever talks to infosys.beckhoff.com, and a failed
 * fetch can therefore only fail *the script*, never the product.
 *
 *     node scripts/fetch-pragma-catalog.js            # fetch, diff, write
 *     node scripts/fetch-pragma-catalog.js --check    # fetch and diff only; exit 1 if it would change
 *
 * Behind a TLS-inspecting corporate proxy, Node's bundled CA list will not chain and every fetch fails
 * with "self-signed certificate in certificate chain" — run `node --use-system-ca scripts/…` so Node
 * trusts the machine's certificate store instead (verified on this development machine). The script
 * detects that specific failure and says so rather than reporting a bare "fetch failed".
 *
 * ## Why two extraction strategies
 *
 * Infosys splits pragmas into five categories under the "Pragmas" page (`ROOT_ID`). Only one of them —
 * **attribute pragmas** — is an open-ended list, and that one publishes itself as a link list, one child
 * page per attribute (`<ul class="schema-linklist hierarchy">`). That list is scraped: it is the part
 * that actually grows between TwinCAT builds, and the page titles carry the names verbatim, including
 * the dual forms (`Attribute 'const_replaced', attribute 'const_non_replaced'`, `Attribute 'noflow' /
 * 'flow'`), which is why every quoted name in a title becomes its own entry.
 *
 * The other four categories are closed grammars — four message keywords, six conditional keywords, two
 * region keywords, two warning forms — documented in prose *inside* the page rather than as child links.
 * Scraping prose for eleven items that have not changed in a decade would buy brittleness and nothing
 * else, so they are declared in `DIRECTIVES` below and **verified** against the fetched page text: if a
 * declared keyword stops appearing on its own documentation page, this script fails loudly rather than
 * writing a catalog that silently disagrees with the docs.
 *
 * ## What this catalog is NOT
 *
 * It is not the whole truth, and the consumer must not treat it as such. Infosys documents what Beckhoff
 * supports; it does not document everything TwinCAT *accepts*. Measured against 337 installed library
 * archives and 299 real project source files on the development machine, names such as `TcGenerated`
 * (150 archives), `no-analysis` (155), `message_guid` (102) and `object_name` (59 archives / 40 uses in
 * real project code) occur constantly and appear on no Infosys attribute page. Those live in the
 * hand-curated `src/lsp/pragmaCatalogExtra.json`, and anything in neither file is still handled by shape
 * matching in `src/lsp/pragmas.js`. User-defined attributes are an explicitly supported feature, so an
 * unknown name is never an error.
 */

const fs = require('fs');
const path = require('path');

const DOC_BASE = 'https://infosys.beckhoff.com/content/1033/tc3_plc_intro/';
const ROOT_ID = '2529556363';
const OUT_FILE = path.join(__dirname, '..', 'src', 'lsp', 'pragmaCatalog.json');

/**
 * The five category pages, keyed by the `kind` the catalog exposes. `match` identifies the category
 * from the root index's own link titles, so a retitled page is noticed instead of silently dropped.
 */
const CATEGORIES = [
    { kind: 'message', id: '2529561739', match: /message pragmas/i },
    { kind: 'attribute', id: '2529567115', match: /attribute pragmas/i },
    { kind: 'conditional', id: '2529795979', match: /conditional pragmas/i },
    { kind: 'region', id: '3525631371', match: /region pragma/i },
    { kind: 'warning', id: '2529790603', match: /warning suppression/i }
];

/**
 * The closed grammars. `verify` is the literal that must still occur in the category page's text —
 * chosen to be the documented *syntax*, not a passing mention, so a doc rewrite that changes the form
 * trips the check.
 */
const DIRECTIVES = [
    { name: 'text', kind: 'message', category: 'message', syntax: "{text <'text string'>}", verify: '{text' },
    { name: 'info', kind: 'message', category: 'message', syntax: "{info <'info string'>}", verify: '{info' },
    { name: 'warning', kind: 'message', category: 'message', syntax: "{warning <'warning string'>}", verify: '{warning' },
    { name: 'error', kind: 'message', category: 'message', syntax: "{error <'error string'>}", verify: '{error' },

    { name: 'IF', kind: 'conditional', category: 'conditional', syntax: '{IF <expr>}', verify: '{IF' },
    { name: 'ELSIF', kind: 'conditional', category: 'conditional', syntax: '{ELSIF <expr>}', verify: '{ELSIF' },
    { name: 'ELSE', kind: 'conditional', category: 'conditional', syntax: '{ELSE}', verify: '{ELSE}' },
    { name: 'END_IF', kind: 'conditional', category: 'conditional', syntax: '{END_IF}', verify: 'END_IF' },
    { name: 'define', kind: 'conditional', category: 'conditional', syntax: "{define <identifier> '<value>'}", verify: '{define' },
    { name: 'undefine', kind: 'conditional', category: 'conditional', syntax: '{undefine <identifier>}', verify: '{undefine' },

    { name: 'region', kind: 'region', category: 'region', syntax: '{region "description"}', verify: '{region' },
    { name: 'endregion', kind: 'region', category: 'region', syntax: '{endregion}', verify: '{endregion}' },

    { name: 'warning disable', kind: 'warningSuppression', category: 'warning', syntax: '{warning disable <compiler warning>}', verify: 'warning disable' },
    { name: 'warning restore', kind: 'warningSuppression', category: 'warning', syntax: '{warning restore <compiler warning>}', verify: 'warning restore' }
];

/**
 * Operators usable inside a `{IF}` / `{ELSIF}` expression. Declared rather than scraped for the same
 * reason as DIRECTIVES, and verified the same way.
 */
const CONDITIONAL_OPERATORS = [
    { name: 'defined', syntax: 'defined(<identifier>) | defined(variable: <v>) | defined(type: <t>) | defined(pou: <p>)' },
    { name: 'hasvalue', syntax: "hasvalue(<identifier>, '<value>')" },
    { name: 'hastype', syntax: 'hastype(<variable>, <type>)' },
    { name: 'hasattribute', syntax: "hasattribute(<pou|variable>, '<attribute>')" }
];

/**
 * Fetches a page and returns its HTML.
 * @param {string} id Infosys node id.
 * @returns {Promise<string>}
 */
async function fetchPage(id) {
    const url = DOC_BASE + id + '.html';
    let res;
    try {
        res = await fetch(url, { headers: { 'user-agent': 'twincat-plc-toolkit/pragma-catalog' } });
    } catch (err) {
        const cause = (err && err.cause && err.cause.message) || '';
        if (/self-signed certificate|unable to (get|verify)/i.test(cause)) {
            throw new Error(`GET ${url} failed TLS verification (${cause}).\n` +
                'A TLS-inspecting proxy is in the way — re-run as: node --use-system-ca scripts/fetch-pragma-catalog.js');
        }
        throw new Error(`GET ${url} -> ${err.message}${cause ? ' (' + cause + ')' : ''}`);
    }
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return await res.text();
}

/**
 * Strips a fetched Infosys page down to readable text, for the `verify` checks.
 * @param {string} html
 * @returns {string}
 */
function toText(html) {
    const body = html.slice(Math.max(0, html.indexOf('<body')));
    return body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/g, "'")
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&#160;|&nbsp;/g, ' ')
        .replace(/\s+/g, ' ');
}

/**
 * Extracts a page's "Further Information" link list: the child pages, in document order.
 * @param {string} html
 * @returns {Array<{id: string, title: string}>}
 */
function linkList(html) {
    const list = html.match(/<ul class="schema-linklist[^"]*">([\s\S]*?)<\/ul>/);
    if (!list) return [];
    return [...list[1].matchAll(/<a href="(\d+)\.html">([^<]*)<\/a>/g)]
        .map(m => ({ id: m[1], title: m[2].replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/g, "'").replace(/&amp;/g, '&').trim() }))
        .filter(e => e.title);
}

/**
 * Pulls every quoted attribute name out of a child-page title.
 *
 * The titles are not uniform, and the variety is the point: `Attribute 'hide'`,
 * `Attribute 'const_replaced', attribute 'const_non_replaced'`, `Attribute 'noflow' / 'flow'`,
 * `Attribute 'no_assign', Attribute 'no_assign_warning'` all appear. Taking *every* quoted run handles
 * all of them without a special case, and pages with no quoted name at all (`User-defined attributes`)
 * correctly yield nothing.
 * @param {string} title
 * @returns {string[]}
 */
function attributeNamesFromTitle(title) {
    return [...title.matchAll(/'([^']+)'/g)]
        .map(m => m[1].trim())
        .filter(n => /^[A-Za-z_][A-Za-z0-9_+.\-]*$/.test(n));
}

async function main() {
    const check = process.argv.includes('--check');

    // 1. Confirm the root index still lists the five categories we know about. A category that
    //    disappeared or was renamed must be a visible failure, not a quietly shorter catalog.
    const rootHtml = await fetchPage(ROOT_ID);
    const rootLinks = linkList(rootHtml);
    for (const cat of CATEGORIES) {
        const hit = rootLinks.find(l => cat.match.test(l.title));
        if (!hit) throw new Error(`root index ${ROOT_ID} no longer links a page matching ${cat.match} — categories changed`);
        if (hit.id !== cat.id) throw new Error(`category "${hit.title}" moved: expected node ${cat.id}, index says ${hit.id}`);
    }
    if (rootLinks.length !== CATEGORIES.length) {
        throw new Error(`root index lists ${rootLinks.length} categories, expected ${CATEGORIES.length}: ${rootLinks.map(l => l.title).join(' | ')}`);
    }

    // 2. Scrape the one open-ended list.
    const attrHtml = await fetchPage(CATEGORIES.find(c => c.kind === 'attribute').id);
    const attrChildren = linkList(attrHtml);
    const attributes = [];
    const seen = new Set();
    for (const child of attrChildren) {
        for (const name of attributeNamesFromTitle(child.title)) {
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            attributes.push({ name, doc: child.id });
        }
    }
    if (attributes.length < 50) {
        throw new Error(`only ${attributes.length} attribute names scraped — the page layout probably changed`);
    }

    // 3. Verify the closed grammars against their own pages.
    const pageText = {};
    for (const cat of CATEGORIES) pageText[cat.kind] = toText(await fetchPage(cat.id));
    const drift = [];
    for (const d of DIRECTIVES) {
        if (!pageText[d.category].includes(d.verify)) drift.push(`{${d.name}}: "${d.verify}" not found on the ${d.category} page`);
    }
    for (const op of CONDITIONAL_OPERATORS) {
        if (!pageText.conditional.includes(op.name)) drift.push(`operator ${op.name} not found on the conditional page`);
    }
    if (drift.length) {
        throw new Error('documentation drift — declared forms no longer match Infosys:\n  ' + drift.join('\n  '));
    }

    const catalog = {
        $comment: 'GENERATED by scripts/fetch-pragma-catalog.js from Beckhoff Infosys. Do not edit by hand. Names TwinCAT accepts but Infosys does not document live in pragmaCatalogExtra.json.',
        source: DOC_BASE + ROOT_ID + '.html',
        docBase: DOC_BASE,
        categories: CATEGORIES.map(c => ({ kind: c.kind, doc: c.id })),
        directives: DIRECTIVES.map(d => ({ name: d.name, kind: d.kind, syntax: d.syntax, doc: CATEGORIES.find(c => c.kind === d.category).id })),
        conditionalOperators: CONDITIONAL_OPERATORS.map(o => ({ name: o.name, syntax: o.syntax, doc: CATEGORIES.find(c => c.kind === 'conditional').id })),
        attributes: attributes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    };

    const next = JSON.stringify(catalog, null, 2) + '\n';
    const prev = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    // Git's autocrlf checks this file back out with CRLF on Windows, so a byte comparison would
    // report a freshly generated catalog as stale on every clone. Compare content, not line endings.
    const sameContent = prev.replace(/\r\n/g, '\n') === next;

    if (prev) {
        const before = new Set(JSON.parse(prev).attributes.map(a => a.name));
        const after = new Set(attributes.map(a => a.name));
        const added = [...after].filter(n => !before.has(n));
        const removed = [...before].filter(n => !after.has(n));
        if (added.length) console.log('added:   ' + added.join(', '));
        if (removed.length) console.log('removed: ' + removed.join(', '));
        if (!added.length && !removed.length) console.log('no attribute changes');
    }

    if (check) {
        if (!sameContent) {
            console.error(`${OUT_FILE} is out of date — re-run without --check`);
            process.exit(1);
        }
        console.log('catalog up to date');
        return;
    }
    if (sameContent) {
        console.log('catalog unchanged; left as-is');
        return;
    }

    fs.writeFileSync(OUT_FILE, next);
    console.log(`wrote ${path.relative(path.join(__dirname, '..'), OUT_FILE)}: ${attributes.length} attributes, ${DIRECTIVES.length} directives, ${CONDITIONAL_OPERATORS.length} operators`);
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
