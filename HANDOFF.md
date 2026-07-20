# HANDOFF

Where the work *stands*. Read before starting; keep current (handoff rule in [CLAUDE.md](CLAUDE.md)). Target under
100 lines — prune finished items rather than appending, but never drop a real finding to hit it. **Shipped features
live in git history (PRs/commits); this file keeps the findings that would cost to re-derive.**

**Last verified:** 2026-07-20 — `npm test` green (41 harnesses), **0 diagnostics on the sample**. Shipped: **0.3.0**
(PRs #1–#14; 0.1.0 renumbered from 0.4.2 for the fresh public repo; #11 re-shipped 0.2.0 by decision). 0.3.0 =
reference-aware rename (objects, members, folders, virtual folders) incl. visualizations; **user smoke-tested it on the
real project and XAE built cleanly** — packaged + installed.
**Not yet visually confirmed by the user:** the 0.1.3 library grouping and 0.1.4 member expansion in the tree UI —
logic is verified on real data + guard tests, but nobody has eyeballed the rendered tree. Worth doing.

## Constraints / still open
- **Publication:** history was rewritten + the GitHub repo recreated to purge customer/vendor content (`sample/`,
  `.trust-lsp/`, machine codenames — 0 blobs match any customer id). Repo is **Private**. **Open:** confirm the
  contractual right to open-source the extension itself.
- **`sample/` is GROUND TRUTH** — correct TwinCAT code, so every diagnostic on it is a bug. At **zero**;
  `test_sample_diagnostics`/`test_typecheck` ratchet it (never raise the baseline). Gitignored → a fresh clone has
  none and the sample suites SKIP.
- **Internal ids deliberately NOT renamed** (`twincat.*` commands, `twincat.xmlViewer` viewType) after the
  "XML Viewer"→"PLC Toolkit" rename — churning them breaks saved keybindings/associations.
- **Objects-tree drag & drop + copy/paste** (0.2.0). DnD = move: component → own file's virtual folder /
  file node (a FolderPath attribute edit), file/dir → directory / empty area (fs move + `.plcproj` re-sync).
  Copy/paste = duplicate (`clipboardCommands.js`, Ctrl+C/V + context menu): components paste **cross-file
  deliberately** (POU↔ITF kind-gated, actions/transitions never into an ITF, fresh GUID Ids, LineIds not copied);
  file paste **always renames** (a same-name copy = duplicate symbols), rewrites root Name/header/LineIds
  (`renameRootObjectInXml`) and regenerates every Id GUID (`regenerateObjectIdsInXml` — kept a SEPARATE step:
  a future rename-in-place must keep Ids); directories deliberately
  not copyable v1 (recursive duplicate = mass duplicate symbols). Matrices pure in `dndRules.js`
  (`test_dnd_rules`); XML edits guarded by `test_xml_folderpath` + `test_xml_clipboard`. **TwinCAT's XML
  loader is ORDER-SENSITIVE**: root `<Folder>` tags must sit between the root Implementation (Declaration
  for Itf) and the first member — the old `insertFolderIntoXml` appended them before `</POU>`, and XAE
  then dropped the FB's members from compile (C0004 per method/property). Fixed (root folders now join the
  contiguous folder group / land after the root `</Implementation>`; guarded in `test_xml_folderpath`);
  one incident file existed in the wild (user's FB_Clamping, repaired separately). Controllers
  (`treeDragAndDrop.js`, `clipboardCommands.js`) are vscode-bound; **user tested both live 2026-07-16: good**. Virtual folders
  NOT draggable/copyable in v1 (moving one = rewriting every member's FolderPath prefix — but they ARE renameable, 0.3.0).
  `engines.vscode` bumped **1.60 → 1.66** (TreeDragAndDropController).
- **Objects-tree rename** (0.3.0, `renameCommands.js` + `renameEngine.js` + `custom/referencesForSymbol`): files,
  members, disk dirs, virtual folders; F2 + context menu; reference-aware modal (rename-only vs update-all).
  Load-bearing findings: the by-symbol LSP entry point exists because a **GVL's name never appears in its own ST**
  (no seed position) and the name-keyed index needs an **identity guard** (uri mismatch → resolved:false, never scan
  the wrong object). `renameEngine` maps raw-ST-unit coords → CDATA splices with a never-write-on-mismatch guard;
  synthesized lines (ACTION headers, GET/SET keywords) are skipped; **raw mode rewrites PROGRAM→FUNCTION_BLOCK when
  methods exist** (stConverter:54-57), shifting the root header column → guard-skip, completed by
  `renameRootObjectInXml`, which the engine deliberately never applies (caller contract). `propagateDeclRenames`
  structurally renames related interface/override decl headers (splice alone would desync tag Name + LineIds =
  corruption); **sibling implementors of a shared interface are NOT in the reference set** (pairwise relation) —
  v1 limit, XAE flags them. `.st` rename = disk-only (never a `.plcproj` member anywhere in the codebase).
  References modal excludes the self-declaration via the response's separate `declaration` field.
  **Non-code objects** (user's smoke test caught the gap — XAE build broke): rename scans them via
  `custom/configReferencesForSymbol` (`features/configReferences.js`). Two matcher families, dispatched by ext:
  **chains** — `.TcVIS`/`.TcVMO` (`<v n="BasicTypeNodeValue">"GVL_X.fb.member"</v>`, plus real ST in `STSnippet`)
  and `.TcTLO`/`.TcGTLO` (dynamic-text entries are literal symbol paths, e.g. `"GVL_X.arr[INDEX]"` — the chain
  regex stops at `[`, verified); **task POU calls** — `.TcTTO` `<PouCall><Name>MAIN</Name></PouCall>`, matched only
  for ROOT renames, only when the value has **no dot** (that rule is what protects the library POU
  `VisuElems.Visu_Prg`), value whitespace-trimmed with the offset carried. **Polarity flip is deliberate**:
  code-side keeps unresolvable occurrences, config-side renames ONLY what provably resolves through the type model
  — decoys share the exact shape (text keys `Encoderpos.Turn1` sit beside real paths in the same GTLO; visu-lib
  names `VisuDialogs.*`) and an unproven edit corrupts the HMI. All these formats carry a **UTF-8 BOM** the LSP must
  strip (VS Code documents exclude it → offsets shift by one). Surveyed and deliberately NOT scanned: `.TcIPO`
  (only `.svg` names), `.plcproj` (already synced by the file-rename step), `.tmc` (generated build artifact).
  Sample counts: `GVL_HMI_Manuell` 666 (665 visu + 1 GTLO), `MAIN` 3 (1 PouCall + 2 visu).
- **README.md** = public page (ships); **DEVELOPMENT.md** = build/test/architecture; CLAUDE/HANDOFF/DEVELOPMENT are
  `.vscodeignore`d. Package `npx @vscode/vsce package`. `scripts/` ships (the generator). Stale local branches
  `moe`/`native-editor` un-pushed.
- **Architecture roadmap COMPLETE** (H1 `features.js` facade · H2 `symbolNode` · M2 injectable index · M3 thin
  `extension.js` → `src/commands/` + `src/xaeShell.js` · L2 perf guard — all merged). **L1 (reverse index) DEFERRED
  by decision** — reference search is already 29 ms cold / ~4 ms warm; reopen only past ~1000 files or >200 ms.

## Diagnostics: how to measure (get this wrong and the number is fiction)
Mirror `server.js`: index libraries up front, then **per file** `convertXmlToSt(parsed,{raw:true})` →
`parseAndIndexDocument(stText,uri)` → `registerLibrarySymbolNodes(index,stText)` → `provideDiagnostics(...)`. Three
traps that have bitten: **non-raw** conversion strips decl-site init lists (`fb:FB_X(a:=b)`→`fb:FB_X;`) and hides
diagnostics; omitting `parseAndIndexDocument` gives methods **stub ranges** → every method-local var reads undeclared
(fabricated ~2,300 phantom diagnostics — the old "2550 baseline" was fiction); omitting `registerLibrarySymbolNodes`
→ 171 false positives. `test/_baseline.js` is truth; baselines are machine-**measured**: `full`=**0** ·
archives-only=12 · typesystem-only=69 · none (fresh clone)=171 — the harnesses detect which row they're on.

## External symbols: five sources, all load-bearing (`libsymbols.js`)
~32k symbols, ~200 ms, registered into the index **on demand, per document** — registering all up front took the
diagnostics pass 1.5 s → **78 s** (`Object.keys()` runs per identifier). Don't "simplify".
- **ZIP archives** (`.compiled-library`, `-ge33`, `.library`) — names in a `__shared_data_storage_string_table__`
  entry. **`.compiled-library-v3` is opaque** (magic `10 a6 d5 a7`), skipped. Dropping `-ge33` once stranded
  Tc2_EtherCAT / Tc2_ControllerToolbox / Tc3_IotBase / Tc2_XmlDataSrv.
- **The project `.tmc`** — only source of **struct fields, enum values, FB/interface methods (with params)**; an
  unmarked `<Method>` param is an INPUT (unlike an unmarked SubItem). Only the ~354 types the project *uses*; **no
  functions, no constants, no ACTIONs**.
- **`.plcproj` namespaces** (`libraries.js`).
- **`library-signatures.xml`** (optional; generator below) — function sigs, FB I/O for unused FBs, global constants.
  No FB methods / struct fields → **`.tmc` wins on overlap**. Gitignored — never leave one in `sample/`.
- **browsercache** (`browserCache.js`) — FB/interface method + property **names** for every referenced library (below).

Library nodes are `external:true`; `typeFromNode()` maps them to the **anonymous** UNKNOWN. That anonymity is
load-bearing — a *named* unknown makes `declarationTypes` flag it; same for `dutKind==='alias'`. **Member-checking
library types must stay OFF** — four guards in `types.js` (`lookupMember` returns `undefined` not `null`; the taint
propagates to derived member types; `isAssignable` = ok if either side external; `getCallParams`/`getInitParams`
decline on external). Disabling guard #1 → 79 false positives (`AXIS_REF.ReadStatus` is an ACTION the `.tmc` lacks).

## Library tree: grouping + members
- **Grouping is data-driven, NOT name prefixes** (`E_DriveDynamicParameter` is not an enum): `type="Interface"`→
  interface; a `VarGlobal` whose constants are all **self-typed** (DataType≈Name, case-insensitive) = **enum** (the
  constants are its values); a mixed-type `VarGlobal` = **GVL**; `type="Type"` stays opaque, and the `.tmc` upgrades
  used ones to struct. Interfaces + GVLs groups added; enums/GVLs expandable, members insert namespace-qualified.
- **browsercache members** — FB/interface expand to method+property **names** (`%ProgramData%\…\Managed Libraries\
  <Co>\<Title>\<Ver>\browsercache`, plain XML). **Names only** — no params/return (those live in the opaque binary
  `.object` entries), so the `.tmc` wins on overlap and a browsercache method carries **no `params` key** (tree shows
  a bare name, not a fake `()`). A direct child of FB `{6f9dac99}`/interface `{6654496c}` is a **property**
  `{5a3b8626}` else a **method**; Get/Set accessors are a property's own children. **No distinct ACTION TypeGUID** —
  `{f89f7675}` is an interface method. `indexBrowserCache` runs LAST in `indexLibraries`.
- **GVLs:** members come only from the signatures' `<Constant>` entries — the generator exports only
  `VAR_GLOBAL **CONSTANT**`, never plain globals (browsercache GVL nodes are leaves; `.tmc` has no GVLs). So a GVL of
  non-constant globals genuinely shows no members and renders as a **leaf** with a `no exported globals` hint + a
  tooltip (not a bug — verified: those `VarGlobal` blocks are just `<Name>`). **Compiler-internal `__*` names** (auto-
  generated backing GVLs like `__TL_Foo__GVL`) are **hidden from the tree** (`getLibraryCatalog` filters `/^__/`;
  display-only, the names stay declared symbols).
- **Struct hard-limit — investigated + verified, do NOT re-chase:** structs the `.tmc` doesn't cover stay in "Data
  Types". struct/enum/alias share ONE "DUT" TypeGUID (`ST_Fanuc_DI`==`E_FanucState`==`{2db5746d}`), DUT nodes carry
  no fields, signatures are bare names, and `GetLibraryIecDeclaration` is E_NOINTERFACE on this build → struct-vs-alias
  is not recoverable offline (closed routes: encrypted `__languagemodel` entropy 7.999; opaque binary `.object`;
  Beckhoff decoder DLLs need the dead-headless CODESYS host).

## Signature generator (`scripts/generate-library-signatures.ps1`, run by `twincat.updateLibraryDefinitions`)
**Every DTE incantation is documented in the script's own header — read it before touching; each line was paid for
empirically.** Load-bearing traps (in the header): normalize non-numeric versions to `*` (else `AddLibrary` silently
drops the library); **never name a local `$shellExe`** (PowerShell names are case-insensitive → collides with the
`$ShellExe` param and ran the wrong bitness); **NEVER `GetActiveObject` — use `Get-DteByPid`** (it once `Quit()`-ed a
user's open shell); bitness is the user's choice, x64 the more complete source on the test rig.

## Find References: a bug in ONE FB is a PARSER bug until proven otherwise
The classic: `fbQueue.Get(Item:=n)` read as a GET **accessor** → parser scanned for an `END_GET` that never comes and
swallowed 24 of an FB's 44 methods (their vars invisible → completion/diagnostics/definition silently broken there;
references kept the unresolved). Check `node.methods.length` vs the `METHOD` lines. Guarded by `test_parser_constructs`.
Scope rules (`test_references_scope`): a method's plain `VAR` is private, but **`VAR_INPUT/OUTPUT/IN_OUT` are
parameters, named at call sites — do NOT confine them** (user corrected me). A named arg belongs to the CALLEE;
a method var's identity is (POU family, method **name**, var name). A named-arg **VALUE** (`x:=x`) resolves in local
scope, not to the parameter — `definition.js` gates the param-name branch on the *next* token being `:=`/`=>` (fixes
definition AND references, which resolve via `definitionAt`). **FB_init decl-site** `inst:FB_T(p:=v)` matches by FB
type via `classifyCallSite` kind `declInitList`.
**Stray `.st` mirrors** (outside the skipped ST_Files/) shadowed same-named XML nodes — the node's uri was hijacked,
the scan read the stale mirror and the real .TcPOU was invisible until opened. Fixed: `parseAndIndexDocument` never
lets a plain .st steal an XML-backed symbol (`test_st_shadow`).
**Duplicate object names from orphan files** (0.3.0 rename smoke, real project): a leftover `POUs\Modulezzz\` backup —
a full copy of `Modules\`, NOT in the `.plcproj` — won the name-keyed index (last-write-wins, sorts last), so a
GVL rename's reference scan visited the orphan `FB_Loading` (no refs) and never the real one; visu updated because it
walks files directly. Fixed: the index is **scoped to the `.plcproj`** — `collectPlcProjObjectPaths` +
`indexTwinCatDirectory(index, dir, includedPaths)` skip on-disk objects the project doesn't `<Compile>` (null set = no
`.plcproj` → index all). Sample has 0 objects outside its `.plcproj` → gate is a no-op there, ratchet safe
(`test_plcproj_scope`). `.st`/visu walks unchanged. NOT scoped: `.st` (indexStDirectory) and the visu file walk —
neither hit the duplicate-name bug.

## Other findings worth not re-deriving
- **Init syntaxes bind differently:** `inst:FB_T(p:=v)` → FB_init's VAR_INPUT (may be inherited → a jump carries the
  *declaring* node's uri); `inst:FB_T:=(p:=v)` → the FB's **own** VAR_INPUT. `classifyCallSite()` is the single shared
  place (definition + completion). Diagnostics take the **union** (`getInitParams`) — don't "fix" it.
- **Reference navigation:** `setPendingSelection` is cleared only by the webview's `selectionApplied` ack (a hidden
  webview's context is torn down, losing the post); `highlightTarget` retries a few frames then searches the intended
  *line* (a 50 ms timer raced to the FIRST same-word occurrence). Panel groups showed a dead expand-arrow (children
  never fetched) when `collapsibleState: Expanded` raced `reveal()` during refresh — fixed with stable TreeItem ids +
  Collapsed nodes + reveal-driven expansion of every root (`expand: 2`).
- **Find References cache:** `readStForFile` caches ST **text** keyed on mtime; word-test a file before tokenizing.
  **Don't cache tokens** (held 19.3 of 22.7 MB on 152 files). The **duplicate search** (peek + panel) now runs on
  **every** Find References (the panel populates unconditionally). Other files are read from **disk** → references into
  a file with unsaved edits in another tab see the *saved* version. `test_references_cache` guards stale-cache + a
  case-sensitive pre-filter dropping hits.
- **Webview:** the CSP needs `font-src ${cspSource}` (codicon font, else blank icons), and the worker AMD `baseUrl`
  must be the monaco-editor **root** (not `.../vs/`, which doubled to `.../vs/vs/…` and 404'd the NLS). The
  `min-maps/*.js.map` CSP error is **DevTools-only, left as-is** — no `connect-src` on purpose (the webview makes no
  network calls).
- **Objects tree icons** (`objectKinds.js`): assert distinct **codepoints**, not names — `symbol-function/-method/
  -constructor` are one glyph (60044) and an unknown id renders blank. `test_object_kinds`.
- **ST lexer** (`test_lexer_literals`): string escape is `$` not `\`; REAL exponents (`3.4E+38`); `_` digit
  separators. Nested block comments `(* (* *) *)` not handled (a CODESYS option, default off).
- **Multi-interface inheritance:** `INTERFACE EXTENDS I_A, I_B` — nodes carry **`extendsAll`** (array; `extends` stays
  the first parent); EXTENDS walkers traverse the DAG breadth-first. `test_interface_multi_extends`. FBs/structs stay
  single-inheritance.
- **Libraries view:** row label is the **namespace** (three spellings differ); `indexLibraryTitles` runs twice per
  pass (keys `kind|include|namespace` or entries double); resolve `symbolCount`/`types` **lazily**; a `.plcproj`
  change must `custom/reindex` **then** refresh; TwinCAT files are webviews (no `activeTextEditor`) → Insert routes
  via `insertTextIntoActivePanel()`.
- **Autocomplete is caret-context aware** (`classifyCaretContext`): `x:▮`→types+namespaces (no `END_IF`); `x:=▮`→
  values; call parens→params first. **Unknown context ⇒ full list, never nothing.**

## Pipeline (open)
0. **`insertComponentIntoXml` places new members AFTER the `<LineIds>` blocks** (just before `</POU>`) — deviates
   from TwinCAT's canonical order (members, then LineIds). Tolerated by XAE so far, but the folder incident proved
   the loader is order-sensitive; deserves the same canonical-anchor treatment as the folder fix.
1. **Chained member completion stops after one hop** (`stAxis.MotionState.▮`) — a member's type is registered only if
   the document text names it; transitive registration hits the 78 s `Object.keys()` cliff.
2. **Nested library namespaces** (`VisuElems.VisuElemBase.▮`) not modelled.
3. **Peek shows only the active component's panes** — cross-file hits go to the panel; an all-external result yields
   `[]` (no peek). Would need hidden Monaco models for other files' ST.
4. **Anonymous-enum CASE selectors** (`e:(a,b)`) don't resolve to an enum node (labels fall back to values).
5. **`Tc2_MC2.▮` returns 2,145 names** — the string table can't separate top-level types from member names.
6. **`parseVariablesBlock` folds pragma tokens into the type string** — harmless while `declarationTypes` is off;
   would fire "Unknown type" the day it is switched on.

## Working agreement
Implementation is delegated to the **`implementer`** agent; the main conversation owns architecture/planning/review/
commits. **Verify every agent claim** (several haven't survived checking); agents run in parallel only with strictly
disjoint file ownership; `package.json`/`HANDOFF.md` stay centrally owned. **Verify your own claims too** — three
times an unmeasured but plausible assumption was wrong. Measure, then report.
