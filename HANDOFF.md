# HANDOFF

Where the work *stands*. Read before starting; keep current (see the handoff rule in [CLAUDE.md](CLAUDE.md)).
Target: under 100 lines — prune finished items rather than appending, but never drop a real finding to hit it.

**Last verified:** 2026-07-15 — `npm test` green (exit 0, 31 harnesses), **0 diagnostics on the sample**. Version 0.1.3 (0.1.0 renumbered from 0.4.2 for the fresh public repo; 0.1.1 = M3 refactor + Find References fixes; 0.1.2 = two webview fixes; 0.1.3 = named-arg-value Go-to-Definition fix + library-tree grouping of interfaces/enums/GVLs); references + navigation confirmed working by the user.

## Publication remediation — DONE (2026-07-15)

Pre-publication licensing/copyright audit acted on and **history was REWRITTEN** (`git filter-repo`), then the
GitHub repo was **deleted and recreated** and the clean history pushed to a fresh **`main`**. What was purged
from **all** commits: `sample/` (152 customer objects + `.tmc` + 88 vendor archives) and `.trust-lsp/` (index
blob with the customer MES endpoint + cert); the customer project name and internal machine codenames were
scrubbed to generic labels in every blob (verified: 0 blobs match any customer identifier). Local `sample/`
restored from backup, now **gitignored**. Added `THIRD-PARTY-NOTICES.md`, `media/monaco-editor/LICENSE.txt`, a
Beckhoff non-affiliation disclaimer (README + `package.json`), corrected README's false Monaco-license claim.
The repo is **Private**; still open before going public: confirm the contractual right to open-source the
extension itself (the customer/vendor *content* is gone, but that's a separate question).

## Snapshot

- **Branch `main`, pushed, working tree clean.** Origin `github.com/AbuShaqra/TC_PLC_Toolkit.git` (repo
  recreated 2026-07-15; `main` is the primary branch — the old `MonacoEditor` name is retired). Stale local
  branches `moe` / `native-editor` still exist, un-pushed.
- **Version `0.1.3`** — 0.1.0 was renumbered from 0.4.2 on 2026-07-15 for the fresh public repo; **0.1.1** added the M3
  refactor + the three fixes below; **0.1.2** adds two webview fixes (see next bullet); **0.1.3** adds the named-arg-value
  Go-to-Definition fix and the library-tree grouping of interfaces/enums/GVLs (both further down). Ships per-kind
  Objects-tree icons, the References panel/peek fixes, the `GET`/`SET` parser fix, and the Find References caching.
- **Go-to-Definition, named-arg VALUE (0.1.3):** `bEnabled := bEnabled` at a call/init site — Go to Definition (and
  Find References, which resolves via `definitionAt`) on the right-hand VALUE used to jump to the callee's parameter
  when the value shared its spelling. `definition.js` section 1 now treats a token as the parameter NAME only when it
  is immediately followed by `:=`/`=>`. Guarded by `test/test_fb_init_def.js`.
- **Library-tree grouping (0.1.3), `librarySignatures.js` + `libraryTreeProvider.js`:** the signatures parser lumped
  every `type="Type"`/`Interface` into "Data Types". Now data-driven (no name prefixes — `E_DriveDynamicParameter` is
  NOT an enum): `type="Interface"`→interface; a `VarGlobal` whose constants are all **self-typed** (DataType≈Name,
  case-insensitive) is an **enum** carrying its values; a mixed-type `VarGlobal` is a **GVL** carrying its globals;
  `type="Type"` stays opaque (the `.tmc` upgrades used ones to struct). New Interfaces + GVLs tree groups; enums/GVLs
  expandable, members insert namespace-qualified. All library nodes stay `external:true` → no diagnostic can fire.
  **Verified on a real project:** IbtCoreLib moved 48 interfaces + 15 enums + 3 GVLs out of "Data Types".
  **Hard limit (investigated + verified, do not re-chase):** structs the `.tmc` doesn't cover STAY in "Data Types" —
  struct/enum/alias share ONE "DUT" TypeGUID in the browsercache (`ST_Fanuc_DI` == `E_FanucState` == `{2db5746d…}`),
  DUT nodes carry no fields, signatures give bare names, and the generator's `GetLibraryIecDeclaration` is E_NOINTERFACE
  on this build — so struct-vs-alias is not recoverable offline. **Open follow-up:** the browsercache
  (`%ProgramData%\…\Managed Libraries\<Co>\<Title>\<Ver>\browsercache`, plain XML) carries **methods/properties/ACTIONs**
  (459 method nodes in IbtCoreLib) for every library FB/interface — the one thing signatures lack (and ACTIONs the
  `.tmc` lacks) — a purely offline source for "expand a library FB to its members".
- **Webview fixes (0.1.2), in `customEditorProvider.js` HTML:** (1) CSP had no `font-src`, so `default-src 'none'`
  blocked Monaco's `codicon.ttf` → editor/suggest/peek icons rendered blank; added `font-src ${webview.cspSource}`.
  (2) the worker's AMD `baseUrl` was `${vsUri}/` (`.../monaco-editor/vs/`), but module ids already start with `vs/`,
  so the worker's NLS file resolved to a doubled `.../vs/vs/base/…` path and 404'd → baseUrl is now the monaco-editor
  ROOT. A third console error (`min-maps/*.js.map` blocked by CSP) is **DevTools-only and left as-is**: source maps are
  not shipped, and the strict no-`connect-src` CSP is intentional (the webview never makes network requests).
  **User confirmed live: the panel tab switches, the reference list is correct, and clicking a reference lands
  in the right place.**
- **`sample/` is GROUND TRUTH**: correct TwinCAT code, so **every diagnostic on it is a bug**. It is at **zero**;
  `test_sample_diagnostics` / `test_typecheck` ratchet it. Never fix a red gate by raising the baseline.
  **`sample/` is now gitignored (local-only) — a fresh clone has none, so the sample-based harnesses SKIP.**
- **README.md is the public extension page** (ships in the VSIX — keep it user-facing); **DEVELOPMENT.md** has
  build/test/architecture; CLAUDE/HANDOFF/DEVELOPMENT are `.vscodeignore`d out. Package with `npx @vscode/vsce
  package`. **All scripts live in `scripts/`** — that folder *ships* (the generator is invoked by
  `twincat.updateLibraryDefinitions`), so dev-only ones are excluded individually in `.vscodeignore`.
- Renamed "TwinCAT XML Viewer" → "TwinCAT PLC Toolkit". **Internal ids deliberately NOT renamed** (`twincat.*`
  commands, `twincat.xmlViewer` viewType, view ids): churning them breaks saved keybindings and editor associations
  for no visible gain. Don't "finish the job".

## Build & test tooling (architecture roadmap — "Now" tier, 2026-07-15)

- **Tests live in `test/`** (30 harnesses + `_baseline.js`), run by **`test/run.js`** — each suite in its own
  process, all run even if one fails, per-suite summary. `npm test` → `node test/run.js`; `node test/run.js <substr>`
  filters. The 3 experimental probes + `make_icon.js` stay in `scratch/`.
- **Type-check gate:** `npm run typecheck` → `tsc --noEmit` (`tsconfig.json`, `checkJs`, scoped to `extension.js`+`src/`,
  excludes `media`/`scratch`/`test`). **No emit — runtime stays plain CommonJS JS.** Currently **0 errors**; keep it there.
  It caught real annotation gaps (isAssignable's `@returns` missing `'related'`, a dead `fileUri` param) but no logic bugs.
- **CI:** `.github/workflows/ci.yml` runs `typecheck` then `test` on push/PR to `main`. `sample/` is absent on CI, so the
  sample suites skip and the rest run (verified green). `test/`, `tsconfig.json`, `.github/` are `.vscodeignore`d out.
- **H1 DONE:** `features.js` is now a 23-line **facade** over `src/lsp/features/{core,completions,definition,references,
  highlights,diagnostics}.js`. Pure structural split (function bodies byte-identical; 64 functions preserved; no cycles —
  `core.js` imports no feature module; shared state stayed put: `stFileCache` in references, `diagnosticsConfig` in
  diagnostics). `require('./features')` and its 7 exports are unchanged. `completions.js` (1044) is the one still-large
  module — cohesive, split further only if it earns it.
- **H2 DONE:** `src/lsp/symbolNode.js` `createSymbolNode()` is the single definition of a node's core shape; both
  `parser.js` and `xmlIndexer.js` build through it (they'd drifted — parser carried `returnType`/`bodyRange`, the XML
  indexer didn't). Source-specific extras (DUT `dutKind`, library `external`/`membersComplete`/`libKind`) layer ON TOP,
  never replace the core. `test/test_symbol_node.js` pins the two indexers to the same shape so they can't drift again.
- **M2 DONE:** the workspace index is now **injectable**. `parseAndIndexDocument` / `indexStDirectory` /
  `clearWorkspaceIndex` take an optional `index` (default = the `parser.js` global, kept for the test harnesses).
  `server.js` owns a private `workspaceIndex` and threads it into every populator and feature call — the parser global
  is no longer the runtime owner. Also fixed a latent bug: the references transient re-index wrote to the global instead
  of the active `symbolIndex` (harmless only because they were the same object). **`server.js` is not unit-tested — the
  change was trace-reviewed; tsc + the 31 suites cover the parser/references halves.**
- **L2 DONE:** `test/test_libsymbols.js` now carries a named PERF GUARD asserting library-symbol registration scales
  with the DOCUMENT, not the registry (pins the lazy-registration invariant behind the 78s cliff).
- **M3 DONE (merged to `main` via PR #1):** `extension.js` **1205 → 359 lines**, now a thin hub. Pure
  structural split; command bodies moved byte-identical. New modules: `src/xaeShell.js` (shell discovery +
  signature-generator — distinct from `src/lsp/librarySignatures.js`, the XML-dump parser), and under
  `src/commands/`: `objectCommands.js` (13 create/delete + `handleComponentCreation`/`handleFileCreation`/`applyXmlEdit`),
  `libraryCommands.js` (6 library-view cmds), `lspBridgeCommands.js` (`openComponent` + 5 `lsp.query*`). Each exports a
  `register*(context, deps)`; `client` stays module-owned in `extension.js`, passed as `getClient: () => client` to
  preserve the `if (!client)` guards. Hub keeps: references view, LSP bootstrap, types broadcast, watchers, view creation.
  **Verified:** tsc 0, 31 suites green, every declared command registered exactly once. **F5-confirmed by the user:**
  activation clean (dev-host exthost log, no errors), New FB works, Insert-from-Library works, Find References works.
- **Three fixes merged with M3 (PR #1):**
  - **Folder-create EISDIR** — `onDidCreate` called `updateCacheForFile`/`indexFileOnLsp` for *every* created path,
    incl. directories, so `readFile(dir)` threw EISDIR (caught+logged; folder still created). Pre-existing, not a
    refactor regression. Now gates on the TwinCAT extension exactly as `onDidChange` does (`extension.js` onDidCreate).
  - **References panel now always populates** — `media/editor.js provideReferences` only posted `showExternalReferences`
    (which fills the "TwinCAT References" panel) when `externalCount > 0`, so an all-local result left the panel empty
    while the peek showed hits. Now posts **unconditionally**; the extension already builds the panel list from the full
    result set. Cost: the extra queryReferences pass (the "duplicate search" below) now runs every time (~8 ms warm).
  - **FB_init decl-site references** — `inst : FB_Type(p := v)` names FB_Type's FB_init VAR_INPUT, but references dropped
    it: `namedArgumentCallee` discarded `classifyCallSite`'s `kind`, so `collect` compared the FB *type* name against the
    target's method name (`FB_init`) and never matched. Now carries `kind`; a `declInitList` site matches by FB type
    (owner or subtype — FB_init may be inherited). Guarded by a new block in `test/test_references_scope.js`.
- **Roadmap COMPLETE.** H1/H2/M2/M3/L2 done; **L1 (reverse index) DEFERRED by decision** (user chose the safe option,
  2026-07-15). It optimises a path already fast at this scale (29 ms cold / ~4 ms warm on 152 files; a regex pre-filter
  already skips tokenizing files without the word) and would add a cache-coherence surface to Find References, which this
  project's history shows is fragile exactly there — risk without a measurable payoff. **Reopen only** when a project
  crosses ~1000 files or reference search exceeds ~200 ms.

## Diagnostics: how to measure (get this wrong and the number is meaningless)

Mirror `server.js`: `indexLibraryNamespaces` + `indexLibrarySymbols` + `indexTypeSystem` (+ `indexLibrarySignatures`)
up front, then **per file** `convertXmlToSt(parsed, {raw:true})` → `parseAndIndexDocument(stText, uri)` →
`registerLibrarySymbolNodes(index, stText)` → `provideDiagnostics(...)`. Three traps, all of which have bitten:
- **non-raw** conversion strips declaration-site init lists (`fb : FB_X(a := b)` → `fb : FB_X;`), hiding diagnostics;
- omitting `parseAndIndexDocument` gives methods **stub line ranges**, so every method-local var reads as undeclared
  — this fabricated ~2,300 phantom diagnostics and made the old "2550 baseline" almost entirely fiction;
- omitting `registerLibrarySymbolNodes` leaves every library symbol unknown (171 false positives).

`test/_baseline.js` is the single source of truth. Baselines are **machine-dependent**, all measured, not assumed:
`full` (archives + `.tmc`) = **0** · `archives-only` = 12 · `typesystem-only` = 69 · `none` (fresh clone) = 171.
All of `sample/` is now git-ignored, so a fresh clone has no sample at all and the sample-based harnesses skip;
with a local `sample/` present but `_Libraries/`+`.tmc` absent you measure 171 — the harnesses detect the row they're on.

## External symbols: four sources, all load-bearing

`src/lsp/libsymbols.js` — ~32k symbols, ~200 ms, registered into the index **on demand, per document**. Registering
all up front took the diagnostics pass from 1.5 s to **78 s** (`Object.keys()` runs per identifier) — don't "simplify".

- **ZIP archives** (`.compiled-library`, `-ge33`, `.library`) — names in a `__shared_data_storage_string_table__`
  entry. **`.compiled-library-v3` is an opaque non-ZIP format** (magic `10 a6 d5 a7`), deliberately skipped. Omitting
  `-ge33` once stranded Tc2_EtherCAT / Tc2_ControllerToolbox / Tc3_IotBase / Tc2_XmlDataSrv.
- **The project `.tmc`** — **not optional**: some resolved types are in *no* readable archive (`CANQUEUE`). Only source
  of **struct fields, enum values and FB/interface METHODS** — a `<DataType>` carries `<Method>` blocks with params
  (`ItemType` gives direction; an **unmarked param is an INPUT**, unlike an unmarked SubItem), `<ReturnType>` and
  `<ExtendsType>`. 860 methods in the sample. But only for the ~354 types the project *uses*, and it has **no
  functions, no constants, no ACTIONs**.
- **`.plcproj` namespaces** (`src/lsp/libraries.js`), 28 of them.
- **`library-signatures.xml`** (optional, below) — function param/return signatures, FB I/O, global constants.

Library nodes carry `external: true` and `typeFromNode()` maps them to the **anonymous** `UNKNOWN` (empty `name`).
That anonymity is load-bearing: a *named* unknown makes `declarationTypes` flag them. Same for `dutKind === 'alias'`.

## Library types: members come from the `.tmc`, and member-CHECKING must stay off

**Diagnostics must never member-check library types.** Four guards in `types.js`: `lookupMember` returns **`undefined`
(uncertain), never `null` (absent)** for an external/`membersComplete:false` node; member types derived from a library
type inherit the taint; `isAssignable` returns `ok` if either side is external; `getCallParams`/`getInitParams` decline
on external nodes. **Disabling guard #1 produced 79 fresh false positives** (`"ReadStatus" is not a member of
"AXIS_REF"`). Methods are known now, but the guards stay: the `.tmc` type list is partial and carries **no ACTIONs** —
`AXIS_REF.ReadStatus` is an action, which is exactly what produced those 79.

## Library signatures (optional 4th source) — DONE

Gives what nothing else can: function signatures, FB I/O for unused FBs, global constants — for *every* referenced
library. Still **no FB methods, no struct fields**, so the **`.tmc` wins on overlap**. `librarySignatures.js` parses;
`libsymbols.js indexLibrarySignatures()` merges (non-opaque `.tmc` entry untouched; absent→insert; opaque+content→
upgrade). **Safety (do not "fix"):** signature data is **never** diagnostic-validated (`getCallParams` declines on any
`external` node). `library-signatures.xml` is **gitignored** — never leave one in `sample/`.

`scripts/generate-library-signatures.ps1` + `twincat.updateLibraryDefinitions`. **Every DTE incantation is documented
in the script's own header — read it before touching it; each line was paid for empirically.** The traps:
- `AddLibrary` rejects symbolic versions (`newest`) and *silently drops the library* → normalize non-numeric to `*`.
- **Never name a local `$shellExe`.** PowerShell variables are **case-insensitive**, so it *is* the `$ShellExe`
  parameter: `$shellExe = $null` erased the user's choice and picking 32-bit ran the **64-bit** shell. Local is
  `$resolvedShellExe`; `Get-DteByPid -ExpectedProgId` now **throws** if the moniker is not the requested ProgID.
- **NEVER attach with `GetActiveObject` — use `Get-DteByPid`.** It drove a user's open XAE Shell and `Quit()` **closed
  their window**. A launching shell registers *two* ROT monikers: `!TcXaeShell.DTE.17.0:<pid>` **and** a PID-less
  CLSID; GetActiveObject binds the *latter* → whichever registered first, i.e. theirs. The ROT enumeration **must be
  C#** — PowerShell's `[ref]` marshalling hands back a late-bound `__ComObject` and `EnumRunning` is not callable.
- Bitness is the **user's choice** (`twincat.libraryDefinitions.shell` = `ask`|`x64`|`x86`); signatures differ (visu
  especially). A configured-but-absent shell falls back to *asking*, never to the other bitness. On the test rig, x86 skips
  the 8 Visu libraries and dumps 71; x64 dumps 76 — **x64 is the more complete source on that machine.**

**Open lead (library ACTIONs, and libraries the project hasn't used):**
`%ProgramData%\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries\<Co>\<Title>\<Ver>\browsercache` is **plain XML** for
**432 of 433** installed versions — a nested `<Node>` tree where nesting *is* the FB→member edge, TypeGUIDs marking
METHOD / PROPERTY / **ACTION** / POU / ITF / DUT / GVL. Names and kinds only, but it covers the `.tmc`'s one real gap
(ACTIONs) and even `-v3`-only libraries. Pure file read, no IDE to drive. Sibling `…\Managed Libraries\cache` lists all
337 installed libraries with an authoritative `DefaultNamespace` — better than `archiveNamespace()`'s title heuristic.
Do **not** re-open the *closed* routes: archive byte-framing (the FB→method edge is absent from the string table);
Beckhoff's decoder DLLs (need the CODESYS IoC host, dead headless, not redistributable); the Automation Interface (the
typelib was reflected in full — no doc/decl export exists); library documentation (the `__languagemodel.auxiliary`
entry is **encrypted**, entropy 7.999 b/byte).

## ST lexer: literal forms (cross-checked against the CODESYS programming reference)

`tokenize()` was audited against the CODESYS reference and three real gaps fixed (guarded by
`test/test_lexer_literals.js`): **(1) the string escape is `$`, not `\`** — `$' $" $$ $N $T $R $L $P`
and `$<hex><hex>`; using `\` let a `$'` or a trailing-backslash string (`'C:\path\'`) mis-terminate and
swallow the code after it (same class as the pragma/GET bugs). **(2) REAL exponent notation** `1.64e+009`,
`1.0E-44` (the sample has `3.4E+38`) — was split into `3.4`+`E`+…, a latent false-positive `E`. **(3) `_`
digit separators** `1_000_000`, `16#FFFF_FFFF`. Also `&` (AND alias) is now an operator, not Unknown.
Still **not** handled by design: **nested block comments** `(* (* *) *)` (a CODESYS project option, default
off) and top-level enum/alias DUT members in the raw pass (xmlIndexer covers those from XML).

## Multiple interface inheritance (INTERFACE I_C EXTENDS I_A, I_B)

An interface may extend **several** interfaces. Both indexers captured only the FIRST parent
(`parser.js` EXTENDS loop and `xmlIndexer.parseInheritance` regex), so a member inherited from a
second parent resolved to nothing — completion/definition missed it and member-access diagnostics
flagged it as "not a member" (a false positive, since a project interface is not "uncertain"). Fixed:
nodes now carry **`extendsAll`** (array; `extends` stays the first parent for compatibility), and the
EXTENDS walkers traverse the whole DAG breadth-first with a visited-set: `parentNames()` +
`lookupMember` / `findMethodOwnerInChain` / `isRelatedAssignable` in `types.js`, and
`walkExtendsChain` in `features.js`. Behaviour is identical for the single-parent case (the sample
holds at 0). Guarded by `test/test_interface_multi_extends.js`. FBs/structs remain single-inheritance
(`collectParams` and the FB nav walkers still single-chain — that's correct).

## Find References: it was a PARSER bug, and the parser is still the first place to look

The user reported "references of `bDone` in FB_Axis.Initialize lists every `bDone` in the project".
Four fixes below were all real bugs, but the cause was none of them: **`fbQueue.Get(Item := n)` was read
as a PROPERTY accessor.** `GET`/`SET` were treated as accessors wherever they appeared, so the parser
scanned forward for an `END_GET` that never comes and swallowed the rest of the enclosing method — its
`END_METHOD` included — and every method after it. In the test rig's `FB_DUT` that ate **24 of its 44 methods**:
their variables were invisible, so completion, diagnostics and Go to Definition were silently broken in
them too. `provideReferences` keeps whatever it cannot resolve ⇒ every same-named variable got listed.
Guarded by `test/test_parser_constructs.js`. **A "references" or "completion" bug that only shows up in
one FB is a parser bug until proven otherwise** — check `node.methods.length` against the `METHOD` lines.

The four real fixes that came out of it (all in `features.js`, guarded by `test/test_references_scope.js`):
- **Coordinate spaces.** The active document is parsed from its ST unit (ST-unit line numbers); every other
  document comes from **`xmlIndexer`, whose ranges are per-component**. `findActiveScope` therefore found no
  enclosing method in any other file. Each scanned document is now re-indexed from its ST **transiently and
  the node restored** — those per-component ranges are what cross-file Go to Definition navigates with.
- **A method's variable belongs to its METHOD.** FB_Axis declares a `bDone` VAR_OUTPUT in Halt, in Stop, in
  Reset… Identity is (POU family, method **name**, var name) — by name, so an override and the interface
  method it implements still match.
- **A named argument belongs to the CALLEE.** `SoEReset(bDone => x)` is SoEReset's parameter. definitionAt
  declines on external nodes (a library FB has no location), so these came back unresolved and were kept.
- **Scope.** A method's plain `VAR` cannot be named outside it. **`VAR_INPUT`/`VAR_OUTPUT`/`VAR_IN_OUT`
  CAN** — they are parameters, named at call sites (`fbAxis.MoveAbsolute(fVelocity := 5)`). Confining them
  would *hide* real references. (The user corrected me on this; don't re-break it.)

Measured on a 251-target sweep of the sample: references **2,974 → 1,291**, unresolved **1,893 → 64**.

## Clicking a reference: the coordinates were never the problem

Verified: 3,438 references on the test rig all map to the right component/pane/line/**columns**. Both bugs were in
the *navigation*: `setPendingSelection` posted to the webview and immediately deleted the selection (a
**hidden** webview has had its context torn down, so the message is lost and nothing remains to retry with —
it is now cleared only by the webview's `selectionApplied` ack); and `highlightTarget` verified the range on
a single 50 ms timer, falling through on a lost race to a **whole-word search that selects the FIRST
occurrence** — a different reference. It now retries a few frames, then searches the intended *line*.

## Find References: cache the TEXT, never the tokens

One search walks **every indexed document**, and none of it was cached: it re-read, re-parsed, re-converted and
re-tokenized the lot — **75 ms per search** on the sample (readFileSync 40.6, tokenize 28.3, XML 2.5, convert 3.3) —
and **one Go to References runs two searches** (peek via `custom/references`, panel via `showExternalReferences`).
`readStForFile` now caches ST text keyed on **mtime**; `provideReferences` **word-tests a file before tokenizing it**
(regex, case-insensitive — ST is). 65 ms → **29 ms cold, ~4 ms warm**.
- **Do not also cache the tokens.** Tried: worth ~1 ms warm, but held **19.3 MB of the cache's 22.7 MB** on 152 files
  (~150 MB at 1000). Text alone is ~1.7 MB per 152 files. The pre-filter already means only the few files containing
  the word get tokenized — which is where that 28.3 ms went.
- `clearStFileCache()` (exported, called from `custom/reindex`) drops deleted files; mtime handles edits.
- **Other files are read from DISK**, so references into a file with unsaved edits in another tab see the *saved*
  version. Pre-existing, not caused by the cache — but now easier to forget.
- `test/test_references_cache.js` guards the two silent failure modes: a stale cache after an on-disk edit, and a
  case-*sensitive* pre-filter dropping real hits.
- **The duplicate search remains** (~8 ms warm, was ~130 ms) and **now runs on every Find References**, not only when
  there are external hits: the panel is populated unconditionally so it is always complete (see the M3-era fixes above).
  Collapsing the two searches means changing the webview protocol — do it when that protocol is open for another reason.

## Objects tree icons: distinct GLYPHS, not distinct names

`src/objectKinds.js` owns kind → codicon → tooltip (`vscode`-free, so it is testable). **Codicon names are aliased:
`symbol-function`, `symbol-method` and `symbol-constructor` are all codepoint 60044** — an early build first shipped with
FUNCTION files and Method rows drawing the identical icon while passing a distinct-*names* check. `function` is now
`symbol-operator`. `test/test_object_kinds.js` extracts the **516-name codicon registry from the vendored Monaco
bundle** (offline) and asserts all 17 kinds resolve to 17 distinct **codepoints** — an unknown id renders *blank*, so a
typo fails silently. Other alias traps it catches: `zap`==`symbol-event`, `symbol-namespace`/`-package`/`-object`==
`symbol-module`, `symbol-value`==`symbol-enum`.

## Other design notes worth not re-deriving

- **The init syntaxes bind to different things.** `inst : FB_T(p := v)` passes args to **`FB_T`'s `FB_init`**;
  `inst : FB_T := (p := v)` initializes the FB's **own** `VAR_INPUT`. **`classifyCallSite()` is the single place that
  lives**, shared by definition + completion; `FB_init` may be inherited, so a jump must carry the *declaring* node's
  uri. **Diagnostics deliberately do NOT discriminate** — `getInitParams()` takes the *union*. Don't "fix" it.
- **Autocomplete is caret-context aware** (`classifyCaretContext()`): `x : ▮` → types + namespaces (no `END_IF`);
  `x := ▮` → values; call parens → params first. **Unknown context ⇒ fall back to the full list, never to nothing.**
- **TwinCAT Libraries view**: the row label is the **namespace** (the three names differ — `RecipeManagement` /
  `Recipe Management` / `Recipe_Management`). Traps: `indexLibraryTitles()` runs **twice** per pass, so catalog entries
  are keyed `kind|include|namespace` or they double; `symbolCount`/`types` must resolve **lazily** in
  `getLibraryCatalog()`. A `.plcproj` change must `custom/reindex` **then** refresh. TwinCAT files are **webviews, not
  text editors**, so `activeTextEditor` is undefined: Insert at Cursor routes via `insertTextIntoActivePanel()`.

## Pipeline (open)

1. **Chained member completion stops after one hop** — `stAxis.MotionState.▮` offers nothing: a member's type is only
   registered if the *document text* names it. Registering transitively adds keys to every `Object.keys()` hot loop —
   see the 78 s perf note first.
2. **Nested library namespaces** (`VisuElems.VisuElemBase.▮`) not modelled. `VisuElems.▮` is empty regardless.
3. **Peek shows only the active component's panes.** `media/editor.js` returns only locations backed by a live Monaco
   model, so cross-file hits go to the panel instead — and an all-external result still yields `[]` (no peek). To peek
   cross-file we would have to create hidden Monaco models for the other files' ST.
4. **Anonymous-enum CASE selectors** (`e : (a, b)`) don't resolve to an enum node, so labels fall back to the values.
5. **`Tc2_MC2.▮` returns 2,145 names** — the string table can't separate top-level types from internal member names.
6. **`parseVariablesBlock` folds pragma tokens into the type string** — `bStart : {attribute 'x'} BOOL;` yields
   `type: "{attribute 'x'} BOOL"` (`parser.js:484/513/523-536`). Harmless while `declarationTypes` is off — it would
   fire "Unknown type" the day it is switched on.

## Working agreement

Implementation is delegated to the **`implementer`** agent ([.claude/agents/implementer.md](.claude/agents/implementer.md));
the main conversation owns architecture, planning, review and commits.

**Verify every agent claim** — several have not survived checking. **Agents run in parallel only with strictly disjoint
file ownership**; `package.json`/`HANDOFF.md` stay centrally owned. **A quiet agent may be dead** — check liveness.
**And verify your own claims**: three times now a plausible, unmeasured assumption has been wrong (a reference timing
taken with the arguments in the wrong order; "the 32-bit shell is a poorer source"; two codicon names that are one
glyph). Measure, then report.
