/**
 * @file features/references.js
 * @description Find References, plus the mtime-keyed ST-text cache the workspace scan walks.
 */

const fs = require('fs');
const { tokenize, TokenType, isSkippable, parseAndIndexDocument } = require('../parser');
const { findNode } = require('../types');
const { registerLibrarySymbolNodes } = require('../libsymbols');
const { parseTwinCatXml } = require('../../xmlParser');
const { convertXmlToSt } = require('../../stConverter');
const { parse: cidParse } = require('../../componentId');
const {
    uriToFsPath,
    normalizeUri,
    findActiveScope,
    convertToLspRange,
    isCallParamScope,
    resolvePathType,
    classifyCallSite
} = require('./core');
const { definitionAt } = require('./definition');
const log = require('../log');

/**
 * Finds all identifier-token occurrences of a word in a code unit (case-insensitive, as ST is).
 * Skips matches inside comments, strings, pragmas, and keywords.
 * @param {string} text Structured Text content.
 * @param {string} word Target identifier.
 * @param {Array<Object>} [preTokens] Token stream of `text`, when the caller already has one.
 * @returns {Array<Object>} LSP ranges (0-based).
 */
function findIdentifierOccurrences(text, word, preTokens) {
    const out = [];
    const lower = word.toLowerCase();
    let toks = preTokens;
    if (!toks) {
        try { toks = tokenize(text); } catch (e) { return out; }
    }
    for (const t of toks) {
        if (t.type === TokenType.Identifier && t.value.toLowerCase() === lower) {
            out.push({
                start: { line: t.line - 1, character: t.col - 1 },
                end: { line: t.line - 1, character: t.col - 1 + t.value.length }
            });
        }
    }
    return out;
}

/**
 * Converted-file cache, keyed by path and invalidated on the file's stat identity.
 *
 * Find References walks every indexed document on *every* search, and none of that work was cached:
 * measured on the 152-file sample, one search spent 40.6 ms in readFileSync, 2.5 ms parsing the XML,
 * 3.3 ms converting to ST and 28.3 ms tokenizing — 75 ms, repeated in full for each search, and a
 * single Go to References issues two of them (the peek and the panel). That was the lag.
 *
 * **Only the ST text is cached — deliberately not the tokens.** Caching tokens too made a warm search
 * ~2 ms faster, but measured on the sample it held 19.3 MB of the cache's 22.7 MB, which extrapolates
 * to roughly 150 MB on a 1000-file project: a lot of a language server's memory to buy 2 ms. Text
 * alone is ~1.7 MB per 152 files (~11 MB at 1000), and the files that must still be tokenized on each
 * search are only the few that actually contain the word — the pre-filter in provideReferences drops
 * the rest before they are ever tokenized, which is where most of that 28.3 ms went anyway.
 *
 * mtime alone is insufficient: copy/deploy tools commonly preserve it, and can replace a file with
 * different contents while leaving the old cache apparently valid. Size, ctime and inode/file-id
 * close that correctness hole without giving up the cheap stat-only warm path.
 * @type {Map<string, {signature: string, stText: string|null}>}
 */
const stFileCache = new Map();

/** Drops the whole converted-file cache (used when the workspace is reindexed). */
function clearStFileCache() {
    stFileCache.clear();
}

/**
 * Returns the Structured Text content for an indexed file, converting from TwinCAT XML when needed
 * and reconverting only when the file has changed on disk.
 * @param {string} fsPath Filesystem path.
 * @returns {string|null} ST text, or null on failure.
 */
function readStForFile(fsPath) {
    let signature;
    try {
        const stat = fs.statSync(fsPath);
        signature = `${stat.mtimeMs}|${stat.size}|${stat.ctimeMs}|${stat.ino || 0}`;
    } catch (e) {
        // `debug`: a reference scan walks the index, and an entry can legitimately have been deleted
        // or renamed since the scan that produced it. The file simply contributes no references.
        log.debug('reference-source-unreadable', { file: fsPath, error: e });
        stFileCache.delete(fsPath);   // gone from disk
        return null;
    }

    const hit = stFileCache.get(fsPath);
    if (hit && hit.signature === signature) return hit.stText;

    let stText = null;
    try {
        const raw = fs.readFileSync(fsPath, 'utf8');
        if (/\.(tcpou|tcgvl|tcdut|tcio|tctleo)$/i.test(fsPath) || /<TcPlcObject/i.test(raw)) {
            const parsed = parseTwinCatXml(raw);
            stText = parsed ? convertXmlToSt(parsed, { raw: true }).stText : null;
        } else {
            stText = raw;
        }
    } catch (e) {
        // `debug`, but the more interesting of the two: the file exists and its XML→ST conversion
        // failed, so this file is silently absent from every reference result and from rename's
        // reference set. A "Find References found nothing" report starts here.
        log.debug('reference-source-conversion-failed', { file: fsPath, error: e });
        stText = null;
    }

    stFileCache.set(fsPath, { signature, stText });
    return stText;
}

/** Identity of a declaration: the file it lives in plus where in that file it starts. */
function defKey(def) {
    return `${normalizeUri(def.uri)}#${def.range.start.line}:${def.range.start.character}`;
}

/**
 * Resolves the declaration scope carried by a definition result.
 *
 * Cross-file XML definitions use component-local ranges, whereas live/transient ST nodes use whole-
 * unit ranges. `componentId` is therefore authoritative when present; interpreting its local line as
 * a whole-unit line can select an unrelated root variable at the same coordinates.
 * @param {Object} def A definition from definitionAt().
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{pou: Object|null, method: Object|null}}
 */
function definitionScope(def, symbolIndex) {
    if (!def) return { pou: null, method: null };
    const uriKey = normalizeUri(def.uri);
    const pou = Object.keys(symbolIndex).map(k => symbolIndex[k]).find(node =>
        node && node.uri && normalizeUri(node.uri) === uriKey) || null;
    const defCid = cidParse(def.componentId);
    if (pou && defCid && defCid.kind === 'method') {
        const methodName = defCid.name.toLowerCase();
        const method = (pou.methods || []).find(m => m.name.toLowerCase() === methodName) || null;
        return { pou, method };
    }
    return findActiveScope(symbolIndex, def.uri, def.range.start.line + 1);
}

/** The method variable named by a definition, respecting component-local XML coordinates. */
function methodVariableForDefinition(def, scope) {
    if (!def || !scope || !scope.method) return null;
    const variables = scope.method.variables || [];
    const defCid = cidParse(def.componentId);
    if (defCid && defCid.kind === 'method' && def.targetWord) {
        const byName = variables.find(v => v.name.toLowerCase() === def.targetWord.toLowerCase());
        if (byName) return byName;
    }
    return variables.find(v => {
        const r = convertToLspRange(v.range);
        return r.start.line === def.range.start.line && r.start.character === def.range.start.character;
    }) || null;
}

/**
 * Describes a resolved definition: which POU owns it, and — when the definition *is* one of that
 * POU's declared members — the member's name.
 *
 * The member distinction is what licenses the inheritance relaxation in sameSymbol(): an override
 * and the method it overrides are two declarations that a reader thinks of as one symbol, but two
 * method-local variables that merely share a name are not, even in related POUs.
 * @param {Object} def A definition from definitionAt().
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{key: string, owner: Object|null, memberName: string|null, methodName?: string}}
 */
function describeDef(def, symbolIndex) {
    const scope = definitionScope(def, symbolIndex);
    const owner = scope.pou;
    let memberName = null;

    // A variable declared inside a METHOD belongs to that method, not to the POU. This matters most
    // for the method's PARAMETERS: FB_Axis declares a `bDone` VAR_OUTPUT in Halt, in Stop, in
    // SwitchOff… and they are all different symbols. Without the method in the identity they compare
    // equal, and asking for one lists every one of them — plus every `bDone` in every FB that has a
    // method of the same shape. The method name (not the node) is what is compared, so that an
    // override in a derived FB — FB_Indradrive.Halt over FB_Axis.Halt — still counts as the same
    // symbol, which it is.
    if (scope.method) {
        const own = methodVariableForDefinition(def, scope);
        if (own) {
            return { key: defKey(def), owner, methodName: scope.method.name, memberName: own.name };
        }
        if (def.targetWord && scope.method.name.toLowerCase() === def.targetWord.toLowerCase()) {
            return { key: defKey(def), owner, memberName: scope.method.name };
        }
    }

    if (owner) {
        const startsAt = (range) => {
            const r = convertToLspRange(range);
            return r.start.line === def.range.start.line && r.start.character === def.range.start.character;
        };
        const v = (owner.variables || []).find(x => startsAt(x.range));
        const m = !v && (owner.methods || []).find(x => startsAt(x.nameRange));
        const p = !v && !m && (owner.properties || []).find(x => startsAt(x.nameRange));
        const a = !v && !m && !p && (owner.actions || []).find(x => startsAt(x.nameRange));
        const decl = v || m || p || a;
        if (decl) memberName = decl.name;
    }

    return { key: defKey(def), owner, memberName };
}

/** The POU's own name plus every ancestor reachable through EXTENDS or IMPLEMENTS. Cycle-safe. */
function inheritanceFamily(node, index) {
    const names = new Set();
    const queue = [node];
    while (queue.length) {
        const cur = queue.shift();
        if (!cur || !cur.name) continue;
        const key = cur.name.toLowerCase();
        if (names.has(key)) continue;
        names.add(key);
        for (const parent of [cur.extends, ...(cur.implements || [])]) {
            if (!parent) continue;
            const n = findNode(index, parent);
            if (n) queue.push(n);
        }
    }
    return names;
}

/** True when one POU derives from the other (either direction), or they are the same POU. */
function pousRelated(a, b, index) {
    if (!a || !b) return false;
    if (a.name.toLowerCase() === b.name.toLowerCase()) return true;
    return inheritanceFamily(a, index).has(b.name.toLowerCase())
        || inheritanceFamily(b, index).has(a.name.toLowerCase());
}

/**
 * Decides whether an occurrence of the word denotes the same symbol as the one under the cursor.
 *
 * The rule is definition identity: `FB_A.Cyclic` and `FB_B.Cyclic` are different symbols because
 * they resolve to different declarations, however alike they read. The two relaxations:
 *
 *   - **Unresolvable ⇒ keep.** If either side cannot be resolved to a declaration (a library symbol,
 *     an undeclared identifier, a chain through a type we have no members for), we have not *proved*
 *     it is a different symbol, so it stays. A missing reference is a worse failure than a spurious
 *     one — the same conservatism the diagnostics are built on, pointed the other way.
 *   - **Overrides and interface implementations are one symbol.** `FB_Derived.Cyclic` overriding
 *     `FB_Base.Cyclic`, or implementing `I_Foo.Cyclic`, is what the reader is looking for when they
 *     ask for references of either — a call through the base dispatches to the override. So a member
 *     of the same name on a POU related by EXTENDS/IMPLEMENTS counts as a hit.
 * @param {Object|null} target describeDef() of the symbol under the cursor; null ⇒ keep everything.
 * @param {Object|null} def The occurrence's resolved definition; null ⇒ keep it.
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {boolean}
 */
function sameSymbol(target, def, symbolIndex) {
    if (!target || !def) return true;
    if (defKey(def) === target.key) return true;

    const occ = describeDef(def, symbolIndex);
    const sameName = !!target.memberName && !!occ.memberName
        && target.memberName.toLowerCase() === occ.memberName.toLowerCase();
    if (!sameName || !pousRelated(target.owner, occ.owner, symbolIndex)) return false;

    // If either side is a variable of a METHOD, both must be — and of the SAME method. FB_Axis
    // declares a `bDone` VAR_OUTPUT in Halt and another in Stop; they share a name and an owning POU
    // but they are two symbols. An override counts as the same method (compared by name), so
    // FB_Indradrive.Halt's `bDone` still matches FB_Axis.Halt's.
    if (target.methodName || occ.methodName) {
        return !!target.methodName && !!occ.methodName
            && target.methodName.toLowerCase() === occ.methodName.toLowerCase();
    }
    return true;
}

/**
 * The method a definition is a PRIVATE local variable of, if it is one.
 *
 * A variable declared in a METHOD's plain `VAR` block exists only inside that method — nothing in
 * another method, POU or file can name it. That is a hard scope rule, and it matters because
 * `sameSymbol` deliberately KEEPS any occurrence whose own definition cannot be resolved (a library
 * symbol, a builtin). That fallback is right in general, but for a method-local target it leaked every
 * unresolvable same-named identifier in the workspace into the results: asking for references of
 * `bDone` inside `FB_Axis.Initialize` listed `bDone`s from completely unrelated code, purely because
 * the resolver could not place them.
 *
 * **`VAR_INPUT` / `VAR_OUTPUT` / `VAR_IN_OUT` are NOT private.** They are the method's *parameters*, so
 * they are named from outside at every call site (`fbAxis.MoveAbsolute(fVelocity := 5)`), often in
 * other files. Confining those to the method body would silently *hide* real references — trading a
 * noisy answer for a wrong one. Only the non-parameter scopes are confined here.
 *
 * @param {Object} def A definition ({ uri, range }).
 * @param {Object} symbolIndex The workspace symbol index.
 * @returns {Object|null} The declaring method, or null if the definition is not private to a method.
 */
function methodLocalScope(def, symbolIndex) {
    if (!def) return null;
    const scope = definitionScope(def, symbolIndex);
    const method = scope && scope.method;
    if (!method || !method.declRange) return null;

    // It must be one of the method's OWN declared variables — not a POU member merely *used* here. An
    // FB's members are reachable from outside through an instance (`fbAxis.bDone`), so they are never
    // confined this way.
    const own = methodVariableForDefinition(def, scope);
    if (!own || isCallParamScope(own.scope)) return null;
    return method;
}

/**
 * True when a definition is declared inside a METHOD at all — any scope, parameters included.
 * @param {Object} def A definition ({ uri, range }).
 * @param {Object} symbolIndex The workspace symbol index.
 * @returns {boolean}
 */
function isMethodScoped(def, symbolIndex) {
    if (!def) return false;
    const scope = definitionScope(def, symbolIndex);
    const method = scope && scope.method;
    if (!method) return false;
    return !!methodVariableForDefinition(def, scope);
}

/**
 * The callee of a NAMED ARGUMENT occurrence — the `x.y` in `x.y(name := v)` / `x.y(name => v)`.
 *
 * A named argument names the CALLEE's parameter, never the caller's own variable. `Halt`'s `bDone`
 * VAR_OUTPUT and the `bDone` in `SoEReset(tTimeout := …, bDone => bStepDone)` are different symbols:
 * the second belongs to SoEReset. definitionAt cannot say so — the callee is usually a library FB, and
 * it declines on external nodes because they have no location to jump to — so the occurrence came back
 * unresolved and the "keep what I cannot resolve" fallback attached it to whatever `bDone` had been
 * asked about. That is what listed the same `bDone` across six files.
 *
 * @param {Array<Object>} tokens The document's token stream.
 * @param {number} tokIdx Index of the occurrence's token.
 * @param {Object} pou Enclosing POU.
 * @param {Object} method Enclosing method.
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{pathParts: Array<string>, kind: string}|null} The call site (callee path + kind), or null
 *          when this is not a named argument. `kind` distinguishes an ordinary call from a declaration-
 *          site FB_init list (`inst : FB_Type(p := v)`), whose callee is the FB *type*, not a method —
 *          the caller needs that distinction to resolve the argument to FB_init's VAR_INPUT.
 */
function namedArgumentCallee(tokens, tokIdx, pou, method, symbolIndex) {
    let j = tokIdx + 1;
    while (j < tokens.length && isSkippable(tokens[j])) j++;
    const next = tokens[j] && tokens[j].value;
    if (next !== ':=' && next !== '=>') return null;   // an assignment statement, not an argument

    const site = classifyCallSite(tokens, tokIdx, pou, method, symbolIndex);
    if (!site || !site.pathParts || !site.pathParts.length) return null;   // not inside a call at all
    return { pathParts: site.pathParts, kind: site.kind };
}

/**
 * True when an occurrence is a qualified member access — something like `x.name` or `arr[i].name`.
 * Whitespace and newlines may sit between the dot and the name, so scan back over them.
 * @param {string} text The document.
 * @param {Object} range The occurrence range ({ start: { line, character } }).
 * @returns {boolean}
 */
function isQualifiedOccurrence(text, range) {
    const line = text.split('\n')[range.start.line] || '';
    let i = range.start.character - 1;
    while (i >= 0 && /\s/.test(line[i])) i--;
    return i >= 0 && line[i] === '.';
}

/**
 * For a qualified occurrence `a.b.NAME`, the TYPE that owns NAME — i.e. what `a.b` resolves to.
 *
 * This is what decides whether `x.bDone` is *our* `bDone`. Relying on definitionAt instead was the
 * flaw: it declines to answer for external (library) nodes on purpose — a library member has no
 * location to jump to — so `fbSetSlaveState.tTimeout` came back unresolved and was then *kept*, as a
 * reference to whatever `tTimeout` the user had asked about. Resolving the base type answers the
 * question that actually matters (whose member is this?) even when there is nowhere to jump to.
 *
 * @param {string} text The document.
 * @param {Object} range The occurrence range.
 * @param {Object} symbolIndex The workspace symbol index.
 * @param {string} uri The document's uri.
 * @returns {string|null} The owning type's name, or null if the base cannot be resolved.
 */
function qualifiedBaseType(text, range, symbolIndex, uri) {
    const lineText = (text.split('\n')[range.start.line] || '').slice(0, range.start.character);
    const m = lineText.match(/((?:(?:THIS|SUPER)\s*\^\s*\.\s*)?[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])?(?:\s*\.\s*[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])?)*)\s*\.\s*$/i);
    if (!m) return null;

    const parts = m[1].replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').split('.').filter(Boolean);
    if (!parts.length) return null;

    const scope = findActiveScope(symbolIndex, uri, range.start.line + 1);
    return resolvePathType(parts, scope.pou, scope.method, symbolIndex);
}

/**
 * Provides Find References.
 *
 * A word match is not a symbol match. Two FBs that each declare a `Cyclic` method share nothing but
 * the spelling, so every occurrence is resolved to the declaration it actually refers to — via the
 * same resolver Go to Definition uses — and only occurrences that land on the cursor's own
 * declaration are reported. See sameSymbol() for the two cases that are deliberately kept anyway.
 * @param {string} code
 * @param {Object} position { line, character }
 * @param {Object} symbolIndex
 * @param {string} fileUri
 * @returns {Array<Object>} LSP Locations
 */
function provideReferences(code, position, symbolIndex, fileUri) {
    const lines = code.split('\n');
    const lineIndex = position.line;
    const lineText = lines[lineIndex] || '';

    // Find the word at the cursor
    const col = position.character;
    let start = col;
    while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
        start--;
    }
    let end = col;
    while (end < lineText.length && /[a-zA-Z0-9_]/.test(lineText[end])) {
        end++;
    }
    const targetWord = lineText.substring(start, end);
    if (!targetWord) return [];

    let tokens = null;
    try { tokens = tokenize(code); } catch (e) { /* fall back to the plain text scan */ }

    // What the cursor is actually on. When this cannot be resolved (a library symbol, a builtin),
    // `target` stays null and every occurrence is reported — the old, purely textual behaviour.
    const targetDef = tokens ? definitionAt(code, tokens, position, symbolIndex, fileUri) : null;
    const target = targetDef ? describeDef(targetDef, symbolIndex) : null;

    // A method-local variable cannot be named outside its method, so the search stops there: the whole
    // workspace pass below is not just wasted, it is what produced the wrong answers (see
    // methodLocalScope). declRange is 1-based; ranges here are 0-based.
    const localTo = methodLocalScope(targetDef, symbolIndex);
    if (localTo) {
        const references = [];
        const first = localTo.declRange.startLine - 1;
        const last = (localTo.declRange.endLine || Number.MAX_SAFE_INTEGER) - 1;
        for (const range of findIdentifierOccurrences(code, targetWord, tokens)) {
            if (range.start.line < first || range.start.line > last) continue;
            if (isQualifiedOccurrence(code, range)) continue;

            const tokIdx = tokens.findIndex(t =>
                t.line === range.start.line + 1 && t.col - 1 === range.start.character);
            if (tokIdx !== -1) {
                const scope = findActiveScope(symbolIndex, fileUri, range.start.line + 1);
                if (namedArgumentCallee(tokens, tokIdx, scope.pou, scope.method, symbolIndex)) continue;
            }

            const def = definitionAt(code, tokens,
                { line: range.start.line, character: range.start.character }, symbolIndex, fileUri);
            if (sameSymbol(target, def, symbolIndex)) references.push({ uri: fileUri, range });
        }
        return references;
    }

    return collectWorkspaceReferences(targetWord, target, targetDef, code, tokens, symbolIndex, fileUri);
}

/**
 * Runs the two-phase occurrence scan both reference queries share: the active/self document first,
 * then every OTHER indexed document (served from the mtime-keyed ST cache, transiently re-indexed so
 * its method scopes resolve, and restored afterwards). provideReferences seeds `target` from a cursor
 * and provideReferencesForSymbol seeds it from the index, but both build the same describeDef()-shaped
 * descriptor and hand it here, so the two can never diverge on what counts as a reference.
 * @param {string} targetWord The identifier to search for (a node or member name).
 * @param {Object|null} target describeDef()-shaped descriptor of the target; null keeps every
 *        occurrence (the purely textual fallback for an unresolvable target).
 * @param {Object|null} targetDef The target's own definition ({ uri, range }); used only to decide
 *        whether the target is method-scoped (a `.member` never reaches a method's own variable).
 * @param {string} code Structured Text of the active/self document.
 * @param {Array<Object>|null} tokens Token stream of `code` (may be null on a tokenize failure).
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {string} fileUri URI of the active/self document.
 * @returns {Array<Object>} LSP Locations.
 */
function collectWorkspaceReferences(targetWord, target, targetDef, code, tokens, symbolIndex, fileUri) {
    const references = [];
    const visitedUris = new Set();

    // A variable declared inside a METHOD — parameters included — is never reached through a dot.
    // `fbSetSlaveState.tTimeout` is some other type's member; `stParams.eBufferMode` is a struct field.
    // Both used to be reported as references to a method's own `tTimeout` / `eBufferMode`, because the
    // resolver could not place them (the base is often a library type, which has no location by design)
    // and unresolvable occurrences are kept. This needs no resolution: it is syntax.
    //
    // Method PARAMETERS are still searched workspace-wide, because a call site names them —
    // `fbAxis.MoveAbsolute(fVelocity := 5)` — but always after a `(` or a `,`, never after a `.`.
    const targetInMethod = isMethodScoped(targetDef, symbolIndex);

    /** Keeps the occurrences of `targetWord` in one document that refer to the cursor's symbol. */
    const collect = (text, docTokens, uri) => {
        for (const range of findIdentifierOccurrences(text, targetWord, docTokens)) {
            // A named argument belongs to the CALLEE, so it is only our symbol if the callee is the
            // method (or the FB) that declares it.
            if (target && docTokens) {
                const tokIdx = docTokens.findIndex(t =>
                    t.line === range.start.line + 1 && t.col - 1 === range.start.character);
                if (tokIdx !== -1) {
                    const scope = findActiveScope(symbolIndex, uri, range.start.line + 1);
                    const site = namedArgumentCallee(docTokens, tokIdx, scope.pou, scope.method, symbolIndex);
                    if (site && site.pathParts.length) {
                        const callee = site.pathParts;
                        const calleeName = callee[callee.length - 1];
                        if (site.kind === 'declInitList') {
                            // `inst : FB_Type(p := v)` — the argument names FB_Type's FB_init VAR_INPUT,
                            // and the callee written in the source is the FB *type*, not `FB_init`. So it
                            // is our symbol only when the target IS an FB_init parameter and FB_Type is
                            // that owner (or derives from it — FB_init may be inherited). An unresolvable
                            // type is kept, as ever.
                            if (!target.methodName || target.methodName.toLowerCase() !== 'fb_init') continue;
                            const calleeNode = findNode(symbolIndex, calleeName);
                            if (calleeNode && target.owner && !pousRelated(calleeNode, target.owner, symbolIndex)) continue;
                        } else if (target.methodName) {
                            // The target is a method's parameter: only a call to THAT method names it.
                            // `fbAxis.Halt(bDone => x)` yes; `SoEReset(bDone => x)` no.
                            if (calleeName.toLowerCase() !== target.methodName.toLowerCase()) continue;
                        } else if (target.owner) {
                            // The target is an FB's own input/output: the callee must be an instance of
                            // that FB (or a relative). An unresolvable callee is kept, as ever.
                            const calleeType = resolvePathType(callee, scope.pou, scope.method, symbolIndex);
                            if (calleeType) {
                                const calleeNode = findNode(symbolIndex, calleeType);
                                if (!calleeNode || !pousRelated(calleeNode, target.owner, symbolIndex)) continue;
                            }
                        }
                    }
                }
            }
            if (target && isQualifiedOccurrence(text, range)) {
                // `something.NAME` — so NAME is a member of `something`. If we can work out what that
                // is, it settles the question without needing the occurrence itself to be resolvable.
                if (targetInMethod) continue;   // a method's variable is never reached through a dot

                const baseType = qualifiedBaseType(text, range, symbolIndex, uri);
                if (baseType && target.owner) {
                    const baseNode = findNode(symbolIndex, baseType);
                    // No node for a type we *did* resolve means it is not a workspace object — it is a
                    // library type (those are indexed by name only, on demand, and often not at all).
                    // Either way the member belongs to that type, and the target's owner is always a
                    // real workspace node, so this cannot be the same symbol.
                    if (!baseNode) continue;
                    if (!pousRelated(baseNode, target.owner, symbolIndex)) continue;
                }
                // A base we could not resolve at all stays in: losing a real reference is worse than
                // listing a doubtful one.
            }
            const def = target
                ? definitionAt(text, docTokens, { line: range.start.line, character: range.start.character }, symbolIndex, uri)
                : null;
            if (sameSymbol(target, def, symbolIndex)) references.push({ uri, range });
        }
    };

    // The active document: match against the in-memory unit (most current content).
    // Compare via normalized URIs so an encoded active URI and an unencoded indexed
    // URI for the same file are recognized as identical (avoids skip + double-listing).
    visitedUris.add(normalizeUri(fileUri));
    collect(code, tokens, fileUri);

    // Other indexed documents: served from the mtime-keyed cache, converting TwinCAT XML to ST only on
    // a miss. A file that does not contain the word at all is skipped BEFORE it is tokenized, which is
    // where a search used to spend 38% of its time — a searched identifier appears in a handful of
    // files, not in all of them. The test is case-insensitive because ST is (`fbPump` and `FBPUMP` are
    // the same symbol), and it runs as a regex over the cached text rather than against a lower-cased
    // copy, so nothing extra is allocated or held. It only decides whether a file is worth tokenizing;
    // findIdentifierOccurrences still does the real matching, respecting comments and strings.
    const wordRe = new RegExp(`\\b${targetWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (!node.uri || visitedUris.has(normalizeUri(node.uri))) continue;
        visitedUris.add(normalizeUri(node.uri));

        const stText = readStForFile(uriToFsPath(node.uri));
        if (!stText || !wordRe.test(stText)) continue;

        let stTokens;
        try { stTokens = tokenize(stText); } catch (e) { continue; }

        // Re-index this document from its ST, transiently.
        //
        // The index holds two different kinds of node. The ACTIVE document is parsed from the ST unit
        // (server.js does this on every edit), so its method ranges are in ST-unit coordinates and a
        // scope lookup works. Every OTHER document comes from xmlIndexer, whose ranges are *per
        // component* — right for jumping to a definition, meaningless as ST-unit line numbers. So
        // findActiveScope found NO enclosing method for any line in any other file, every method
        // variable there resolved to nothing, and `sameSymbol` keeps what it cannot resolve. That one
        // mismatch produced the overwhelming majority of the wrong references: 1,885 of the 1,893
        // unresolved occurrences measured on the sample were plain identifiers failing exactly here.
        //
        // The node is restored afterwards, because those per-component ranges are what cross-file Go to
        // Definition navigates with — overwriting them for good would fix references and break jumps.
        const restore = snapshotNodesFor(symbolIndex, node.uri);
        try {
            // Re-index into the ACTIVE index (symbolIndex), not the parser's default global — otherwise
            // this transient re-index would land in a different index than the one being searched.
            parseAndIndexDocument(stText, node.uri, symbolIndex);
            collect(stText, stTokens, node.uri);
        } finally {
            restore();
        }
    }

    return references;
}

/**
 * Provides Find References for a symbol identified by NAME instead of by a cursor position — the query
 * a rename needs. The position-based provideReferences cannot seed on a GVL: a GVL's own name never
 * appears in its converted ST, so there is no cursor to start from. This resolves the target straight
 * from the index and reads the target's file off disk (`readStForFile` converts the XML, the same path
 * production uses), then runs the identical workspace scan.
 *
 * @param {{ rootName: string, fileUri: string,
 *           member?: { kind: 'Method'|'Property'|'Action', name: string } }} spec The symbol to search
 *        for: a root object by name, optionally narrowed to one of its members.
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{ resolved: boolean,
 *             references: Array<{uri: string, range: Object}>,
 *             declaration: {uri: string, range: Object}|null }} `resolved` is false when the symbol
 *          cannot be pinned down (unknown/external root, identity mismatch, unreadable file, missing
 *          member); `declaration` is the target's own declaration so the caller can exclude it from a
 *          user-facing reference count.
 */
function provideReferencesForSymbol(spec, symbolIndex) {
    const unresolved = { resolved: false, references: [], declaration: null };
    if (!spec || !spec.rootName) return unresolved;

    let node = findNode(symbolIndex, spec.rootName);
    // A library symbol has no file to rename in (external:true, no real uri/range), and an unknown
    // name cannot be resolved at all.
    if (!node || node.external) return unresolved;

    // Identity guard. The index is name-keyed and last-write-wins, so the node under this name may
    // belong to a DIFFERENT file than the caller meant (two objects can share a root name across a
    // malformed project, or the caller may simply be stale). Scanning it would edit the wrong object,
    // so a uri mismatch is a hard no. Compare the same normalized way the scan compares uris.
    if (!node.uri || !spec.fileUri || normalizeUri(node.uri) !== normalizeUri(spec.fileUri)) {
        return unresolved;
    }

    const stText = readStForFile(uriToFsPath(node.uri));
    if (stText == null) return unresolved;

    // parseAndIndexDocument replaces this file's index entry (for a POU/ITF) with a node whose method/
    // property/action ranges are in ST-UNIT coordinates — the very coordinates every occurrence of the
    // symbol resolves to. defKey equality in the scan hinges on the target holding those same
    // coordinates, so this re-index is mandatory, not an optimization. It mutates the index, so the
    // node is snapshotted and restored: the on-disk (per-component) ranges are what cross-file Go to
    // Definition navigates with, and must survive this call untouched.
    const restore = snapshotNodesFor(symbolIndex, node.uri);
    try {
        parseAndIndexDocument(stText, node.uri, symbolIndex);
        // Register the library symbols the file references, so a genuine occurrence is not "kept
        // because unresolved" (for a rename, a spurious keep would become a wrong edit).
        registerLibrarySymbolNodes(symbolIndex, stText);

        // After the re-index the POU/ITF entry is a NEW object — re-fetch it.
        node = findNode(symbolIndex, spec.rootName);
        if (!node) return unresolved;

        let targetWord;
        let declRange;
        let target;

        if (spec.member) {
            const collection = spec.member.kind === 'Method' ? node.methods
                : spec.member.kind === 'Property' ? node.properties
                : spec.member.kind === 'Action' ? node.actions
                : null;
            const lower = String(spec.member.name).toLowerCase();
            const m = collection && collection.find(x => x.name.toLowerCase() === lower);
            if (!m) return unresolved;
            targetWord = m.name;
            declRange = m.nameRange;
            // Shape this exactly as describeDef() would for a member-NAME definition: it lands in the
            // owner.methods/properties/actions branch, so memberName is set and there is NO methodName
            // (that field marks a method-LOCAL variable, which this is not). sameSymbol() compares
            // against this, so the shape must match what describeDef() produces for occurrences.
            const targetDef = { uri: node.uri, range: convertToLspRange(m.nameRange) };
            target = { key: defKey(targetDef), owner: node, memberName: m.name };
            return finishForSymbol(targetWord, target, targetDef, stText, node, declRange, symbolIndex);
        }

        // Root object (FB/PRG/FUN/ITF/GVL/DUT). describeDef() of a root name yields memberName:null.
        // GVL's nameRange is the (1,1) stub (its name is not in its own ST), but qualified usages
        // resolve the same base node to the same stub, so the keys still match.
        targetWord = node.name;
        declRange = node.nameRange;
        const targetDef = { uri: node.uri, range: convertToLspRange(node.nameRange) };
        target = { key: defKey(targetDef), owner: node, memberName: null };
        return finishForSymbol(targetWord, target, targetDef, stText, node, declRange, symbolIndex);
    } finally {
        restore();
    }
}

/**
 * Tokenizes the self document, runs the shared workspace scan, and packages the by-symbol result.
 * Split out only so the two target shapes above share one exit path.
 * @param {string} targetWord Node/member name being searched for.
 * @param {Object} target describeDef()-shaped descriptor of the target.
 * @param {Object} targetDef The target's own definition ({ uri, range }).
 * @param {string} stText Structured Text of the target's own file.
 * @param {Object} node The (re-indexed) target node — supplies the self uri.
 * @param {Object} declRange The declaration's 1-based range (node or member nameRange).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{resolved: boolean, references: Array<Object>, declaration: Object}}
 */
function finishForSymbol(targetWord, target, targetDef, stText, node, declRange, symbolIndex) {
    let tokens = null;
    try { tokens = tokenize(stText); } catch (e) { /* fall back to the plain text scan */ }
    const references = collectWorkspaceReferences(
        targetWord, target, targetDef, stText, tokens, symbolIndex, node.uri);
    return {
        resolved: true,
        references,
        declaration: { uri: node.uri, range: convertToLspRange(declRange) }
    };
}

/**
 * Captures every index entry belonging to a uri, and returns a function that puts them back exactly as
 * they were — including removing any node that did not exist before.
 * @param {Object} symbolIndex The workspace symbol index.
 * @param {string} uri The document uri.
 * @returns {Function} The restore callback.
 */
function snapshotNodesFor(symbolIndex, uri) {
    const saved = [];
    const keysBefore = new Set(Object.keys(symbolIndex));
    for (const key of keysBefore) {
        const node = symbolIndex[key];
        if (node && node.uri === uri) saved.push([key, node, { ...node }]);
    }
    return () => {
        for (const [key, node, copy] of saved) {
            // parseAndIndexDocument mutates the node in place, so restore its fields onto the same
            // object — other references to it (there are some) must see the original shape.
            for (const k of Object.keys(node)) if (!(k in copy)) delete node[k];
            Object.assign(node, copy);
            symbolIndex[key] = node;
        }
        for (const key of Object.keys(symbolIndex)) {
            if (!keysBefore.has(key) && symbolIndex[key] && symbolIndex[key].uri === uri) {
                delete symbolIndex[key];   // a node parseAndIndexDocument added that was not there before
            }
        }
    };
}

module.exports = {
    provideReferences,
    provideReferencesForSymbol,
    clearStFileCache,
    // Exported for the configuration-object reference scan (features/configReferences.js), which
    // reuses the exact relatedness relaxation the qualified-occurrence matching here uses, so that
    // reference set and the code reference set can never diverge on what counts as "the same member".
    pousRelated
};
