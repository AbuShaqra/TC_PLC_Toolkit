/**
 * @file pragmas.js
 * @description Classifies TwinCAT pragmas — the `{ ... }` spans that carry metadata rather than code.
 *
 * ## Two tiers, and why both are needed
 *
 * **Shape first.** Every `{ ... }` span is classified by its *form*: the leading keyword decides the
 * category, and nothing else is required. Shape matching is what makes this safe — it handles pragmas
 * TwinCAT gains after this file was written, third-party ones, and the user-defined attributes Beckhoff
 * explicitly supports. `classifyPragma` therefore always returns a result; there is no failure mode.
 *
 * **Then the catalog.** On top of the shape sits a name lookup used only to *enrich*: completion,
 * documentation links, and the canonical spelling. Two files feed it:
 *   - `pragmaCatalog.json` — generated from Beckhoff Infosys by `scripts/fetch-pragma-catalog.js`.
 *   - `pragmaCatalogExtra.json` — hand-curated, measured on real libraries and real project code.
 *
 * The second file exists because the first is provably incomplete: `TcGenerated` occurs in 150 of 337
 * installed library archives and `object_name` in 40 places in real project code, and neither has an
 * Infosys page. Documentation is authoritative about what Beckhoff *supports*; it is not a census of
 * what TwinCAT *accepts*.
 *
 * ## The rule that must not be relaxed
 *
 * **An unrecognised pragma is never an error.** Nothing here feeds a diagnostic, and nothing here
 * decides a colour: highlighting is driven by `kind` (shape), never by `known` (catalog). Colouring an
 * uncatalogued attribute differently would be a diagnostic wearing a costume, and it would be wrong
 * every time someone uses the user-defined attributes TwinCAT documents as a feature.
 */

const documented = require('./pragmaCatalog.json');
const observed = require('./pragmaCatalogExtra.json');

/**
 * Categories a pragma can fall into. `Unknown` is a legitimate outcome, not a failure — see the header.
 * @enum {string}
 */
const PragmaKind = {
    Attribute: 'attribute',
    Message: 'message',
    Conditional: 'conditional',
    Region: 'region',
    EndRegion: 'endregion',
    WarningSuppression: 'warningSuppression',
    Unknown: 'unknown'
};

/** Heads that open/close a foldable region. */
const REGION_HEAD = 'region';
const ENDREGION_HEAD = 'endregion';

/** Conditional-compilation heads (`{IF}`, `{define}`, …). */
const CONDITIONAL_HEADS = new Set(['if', 'elsif', 'else', 'end_if', 'define', 'undefine']);

/** Message-pragma heads. `warning` is also the head of the suppression pragmas — disambiguated below. */
const MESSAGE_HEADS = new Set(['text', 'info', 'warning', 'error']);

/**
 * Folding markers for `{region}` / `{endregion}`, as regex **source strings**.
 *
 * They live here so the three places that need them cannot drift apart: `language-configuration.json`
 * (VS Code's own editor, for loose `.st` files), `media/editor.js` (the webview panes, which is where
 * TwinCAT files are actually edited), and this module. `test_pragmas.js` asserts all three agree —
 * neither of the other two can `require()` anything, so a test is the only mechanism available.
 *
 * `^\s*\{\s*` is deliberate: it anchors to the start of the line, so a `{region` mentioned mid-expression
 * cannot open a fold, while `{ region "x" }` written with spaces still can. `{endregion}` cannot match
 * the start marker because `region` must follow the brace immediately.
 *
 * **Case-sensitive on purpose.** Infosys spells the pragma `{region "description"}` and warns "be sure
 * to follow this syntax so that the pragma is taken into account"; all 163 occurrences across the real
 * projects on this machine are lowercase. Folding something TwinCAT itself would ignore would be worse
 * than not folding it. It also keeps all three declarations byte-identical, which is what makes the
 * sync test meaningful. Note `classifyPragma` is deliberately *more* permissive — it classifies for
 * highlighting, where recognising `{REGION …}` as a pragma is strictly better than not.
 */
const REGION_MARKER_START = '^\\s*\\{\\s*region\\b';
const REGION_MARKER_END = '^\\s*\\{\\s*endregion\\b';

/** Leading word of a pragma body: `attribute`, `region`, `IF`, … */
const HEAD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)/;

/** First quoted run, single or double quotes — the attribute name, or a region's label. */
const QUOTED_RE = /'([^']*)'|"([^"]*)"/;

/** Name lookup, lowercased key -> {name, doc, tier, note}. Built once. */
const attributeIndex = new Map();

for (const attr of documented.attributes) {
    attributeIndex.set(attr.name.toLowerCase(), {
        name: attr.name,
        tier: 'documented',
        doc: documented.docBase + attr.doc + '.html'
    });
}
for (const attr of observed.attributes) {
    // Documented wins on overlap: it carries a real documentation link.
    if (attributeIndex.has(attr.name.toLowerCase())) continue;
    attributeIndex.set(attr.name.toLowerCase(), {
        name: attr.name,
        tier: 'observed',
        doc: null,
        note: attr.note
    });
}

/** Directive lookup (`region`, `IF`, `text`, …), lowercased head -> catalog entry. */
const directiveIndex = new Map();
for (const d of documented.directives) {
    directiveIndex.set(d.name.toLowerCase(), {
        name: d.name,
        kind: d.kind,
        syntax: d.syntax,
        doc: documented.docBase + d.doc + '.html'
    });
}

/**
 * @typedef {Object} PragmaInfo
 * @property {string} kind One of {@link PragmaKind}. Derived from shape alone.
 * @property {string} head Leading keyword, lowercased (`attribute`, `region`, `if`, …); `''` if absent.
 * @property {string|null} name Attribute name for attribute pragmas, region label for `{region}`,
 *   otherwise the head. `null` when there is nothing to name.
 * @property {string|null} value The `:= '<value>'` payload, when the pragma carries one.
 * @property {boolean} known Whether `name` is in a catalog. Informational only — never a diagnostic,
 *   and never a colour.
 * @property {string|null} tier `'documented'` (Infosys) or `'observed'` (measured), else `null`.
 * @property {string|null} doc Documentation URL when one exists.
 * @property {boolean} complete Whether the span was closed with `}`. A half-typed pragma still
 *   classifies — that is what keeps completion alive while the user types it.
 */

/**
 * Classifies one pragma span.
 *
 * Accepts the text with or without its braces, complete or half-typed, because that is what the
 * callers have: the lexer hands over a token that may have stopped at end-of-line, and completion asks
 * about a span the user is still typing.
 * @param {string} text The pragma, e.g. `{attribute 'qualified_only'}` or `{region "Inputs"`.
 * @returns {PragmaInfo}
 */
function classifyPragma(text) {
    const raw = String(text == null ? '' : text);
    const trimmed = raw.trim();
    const complete = /\}\s*$/.test(trimmed);

    let body = trimmed;
    if (body.startsWith('{')) body = body.slice(1);
    if (body.endsWith('}')) body = body.slice(0, -1);

    const headMatch = body.match(HEAD_RE);
    const head = headMatch ? headMatch[1].toLowerCase() : '';
    const rest = headMatch ? body.slice(headMatch[0].length) : body;

    const base = { head, name: null, value: null, known: false, tier: null, doc: null, complete };

    if (head === 'attribute') {
        const quoted = rest.match(QUOTED_RE);
        const name = quoted ? (quoted[1] !== undefined ? quoted[1] : quoted[2]) : null;
        const entry = name ? attributeIndex.get(name.toLowerCase()) : null;
        // `{attribute 'object_name' := 'M_StateMachine'}` — the value is whatever the SECOND quoted run
        // holds, and only after an `:=`. Attributes without a value are the common case.
        const assign = rest.indexOf(':=');
        let value = null;
        if (assign !== -1) {
            const after = rest.slice(assign + 2).match(QUOTED_RE);
            if (after) value = after[1] !== undefined ? after[1] : after[2];
        }
        return {
            ...base,
            kind: PragmaKind.Attribute,
            name: entry ? entry.name : name,
            value,
            known: !!entry,
            tier: entry ? entry.tier : null,
            doc: entry ? entry.doc : null
        };
    }

    if (head === REGION_HEAD || head === ENDREGION_HEAD) {
        const quoted = head === REGION_HEAD ? rest.match(QUOTED_RE) : null;
        const label = quoted ? (quoted[1] !== undefined ? quoted[1] : quoted[2]) : (head === REGION_HEAD ? rest.trim() || null : null);
        const entry = directiveIndex.get(head);
        return {
            ...base,
            kind: head === REGION_HEAD ? PragmaKind.Region : PragmaKind.EndRegion,
            name: label,
            known: !!entry,
            tier: entry ? 'documented' : null,
            doc: entry ? entry.doc : null
        };
    }

    if (CONDITIONAL_HEADS.has(head)) {
        const entry = directiveIndex.get(head);
        return {
            ...base,
            kind: PragmaKind.Conditional,
            name: entry ? entry.name : head,
            known: !!entry,
            tier: entry ? 'documented' : null,
            doc: entry ? entry.doc : null
        };
    }

    if (MESSAGE_HEADS.has(head)) {
        // `{warning 'text'}` prints a message; `{warning disable C0371}` suppresses one. Same head,
        // different pragma — only the next word tells them apart.
        const suppress = head === 'warning' && /^\s*(disable|restore)\b/i.test(rest);
        const entry = directiveIndex.get(suppress ? `warning ${rest.trim().split(/\s+/)[0].toLowerCase()}` : head);
        return {
            ...base,
            kind: suppress ? PragmaKind.WarningSuppression : PragmaKind.Message,
            name: entry ? entry.name : head,
            known: !!entry,
            tier: entry ? 'documented' : null,
            doc: entry ? entry.doc : null
        };
    }

    return { ...base, kind: PragmaKind.Unknown, name: head || null };
}

/**
 * True if the line opens a foldable region. Matches the folding marker exactly, so a caller that folds
 * by classification and one that folds by marker cannot disagree.
 * @param {string} line
 * @returns {boolean}
 */
function isRegionStart(line) {
    return new RegExp(REGION_MARKER_START).test(String(line || ''));
}

/**
 * True if the line closes a foldable region.
 * @param {string} line
 * @returns {boolean}
 */
function isRegionEnd(line) {
    return new RegExp(REGION_MARKER_END).test(String(line || ''));
}

/**
 * The label a `{region "…"}` line carries, for a fold's collapsed text.
 * @param {string} line
 * @returns {string|null}
 */
function regionLabel(line) {
    if (!isRegionStart(line)) return null;
    const span = String(line).match(/\{[^}]*\}?/);
    return span ? classifyPragma(span[0]).name : null;
}

/**
 * Every known attribute name, documented first then observed, each alphabetical. Used to offer
 * completion inside `{attribute '▮'}`; the ordering is what the completion list shows.
 * @returns {Array<{name: string, tier: string, doc: (string|null), note: (string|undefined)}>}
 */
function listAttributes() {
    const all = [...attributeIndex.values()];
    const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return [
        ...all.filter(a => a.tier === 'documented').sort(byName),
        ...all.filter(a => a.tier === 'observed').sort(byName)
    ];
}

/**
 * Catalog entry for an attribute name, or null. Case-insensitive: the lookup is a convenience, and
 * `TcNoSymbol` / `tc_no_symbol` are two catalogued spellings of one attribute.
 * @param {string} name
 * @returns {?{name: string, tier: string, doc: (string|null), note: (string|undefined)}}
 */
function lookupAttribute(name) {
    if (!name) return null;
    return attributeIndex.get(String(name).toLowerCase()) || null;
}

/**
 * Catalog entry for a directive head (`region`, `IF`, `text`, `warning disable`, …), or null.
 * @param {string} head
 * @returns {?{name: string, kind: string, syntax: string, doc: string}}
 */
function lookupDirective(head) {
    if (!head) return null;
    return directiveIndex.get(String(head).toLowerCase()) || null;
}

module.exports = {
    PragmaKind,
    REGION_MARKER_START,
    REGION_MARKER_END,
    classifyPragma,
    isRegionStart,
    isRegionEnd,
    regionLabel,
    listAttributes,
    lookupAttribute,
    lookupDirective
};
