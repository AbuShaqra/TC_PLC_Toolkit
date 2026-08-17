# HANDOFF

Where the work *stands*. Read before starting; keep current (handoff rule in [CLAUDE.md](CLAUDE.md)). Target under
100 lines — prune finished items rather than appending, but never drop a real finding to hit it. **Shipped features
live in git history (PRs/commits); this file keeps the findings that would cost to re-derive.**

**Last verified:** 2026-08-10 **on Windows** — `npm test` green (**57 harnesses, Coverage: FULL**), typecheck clean,
**0 diagnostics on the sample in BOTH library configurations** (Beckhoff archives present and moved aside),
both browser harnesses green, **dev-host harness green 8/8**. Shipped through **0.6.1**; **0.6.2 (indexing
performance) is on branch `perf/indexing`**. Releases are in git history.
**2026-08-17 (Linux container):** typecheck clean, **60/60 harnesses green at Coverage: FULL** — the first fully
green run off Windows, after the platform-correctness fix below. Both browser harnesses build and pass every
functional assertion. Not a substitute for a Windows pass: nothing here exercised VS Code or TwinCAT itself.
**0.6.1 VSIX installed to the user's VS Code 2026-08-10 — awaiting their confirmation after a FULL
VS Code restart** (see the install trap below).
**Install trap that cost a debug cycle:** VS Code keeps the old version dir until a FULL restart (reload-window is not
always enough) — the user tested 0.3.1's feature against the still-running 0.3.0 code and reported it broken. Check
`~/.vscode/extensions/` for side-by-side version dirs + `.obsolete` before debugging a "feature does nothing" report.
**Not yet visually confirmed by the user:** the 0.1.3 library grouping and 0.1.4 member expansion in the tree UI —
logic is verified on real data + guard tests, but nobody has eyeballed the rendered tree. Worth doing. Likewise
the light-theme pass over `media/editor.css` — **no test covers CSS**, contrast was computed against VS Code's
default themes, not eyeballed, and dark mode deliberately changed too. **Its conventions live in that file's own
header comment — read it before adding colour.** The gradient-clipped wordmark is deliberately left at 3.3–4.9:1
(a logotype, exempt); don't "fix" it without a design call.

## Constraints / still open
- **Project-scoped indexing SHIPPED** (user report 2026-08-06; branch `fix/project-scoped-index`, plan in
  `docs/superpowers/plans/2026-08-06-project-scoped-index.md`). A folder holding several PLC projects used to
  collide: the symbol index was one flat name-keyed map for the whole workspace, so **38 object files produced 19
  index entries**, correct code drew a false diagnostic, and Find References returned hits from the wrong project.
  Now **one index per `.plcproj`** — `src/lsp/projectMap.js` owns ownership, `src/lsp/workspaceScan.js` builds and
  routes. Load-bearing decisions: a file `<Compile>`d by two projects indexes into **both** but routes to the one
  whose directory holds it; references and rename are **strictly** project-scoped; `workspaceScan.js` is separate
  from `server.js` because the latter opens IPC at require time and so cannot be loaded by a harness; the
  per-project library registries hang off each index under a **`Symbol` key**, invisible to the `Object.keys()`
  walks in the reference scan and `types.js`, which is why `registerLibrarySymbolNodes(index, code)` needed no
  call-site change. `src/typesCache.js` is **deleted** — the webview never read its map, and the LSP half re-added
  exactly the names the partition excludes.
  **The rename hazard was the one that mattered:** the config-object scan walked every root, so renaming the object
  that *won* the flat name key rewrote the **neighbour's `PlcTask.TcTTO`**, while renaming the one that *lost*
  silently skipped the config update (the `configReferences.js` identity guard rejected it). Both directions are
  gated by `test_multi_project_scope.js`, and that guard was **verified to fail** under a widened `configFilesFor`
  before being accepted.
  **0.6.0 shipped a navigation regression, fixed in 0.6.1** (user report 2026-08-10 "references and definitions
  still broken in multi-project dirs"): the scan indexed each object from the partition's **normalized (lowercased)**
  path, so every scan-time symbol node carried a lowercased uri. The LSP still answered correctly (verified against
  the user's real `C:\Projects\TC_Start` and 8-project `C:\Projects\PLC projects`), but `vscode.openWith()` treats a
  differently-cased uri as a **different resource**, so every cross-file Go to Definition / reference click opened a
  DUPLICATE tab titled `gvl_system.tcgvl` with nothing highlighted — "definitions are broken" to a user, invisible
  to every headless gate (proven in a real dev host). Fix: `projectMap.js` keeps normalized keys for ownership but
  adds `objectFiles` (key → on-disk spelling, **XML-entity-decoded**); `workspaceScan.js` indexes from the values.
  The entity decode is its own real bug: `time&amp;date` stayed `&amp;`, silently dropping **57 of OSCAT's 819**
  compiled objects. Casing pinned in `test_project_map.js` + `test_multi_project_scope.js` (the old `/LineA/i`
  assertions were case-blind by construction); tab identity + live client pinned by **`test/devhost/run.js`** — a
  new run-by-hand harness that drives the installed VS Code headlessly (see DEVELOPMENT.md). That closes the owed
  go-to-definition/types-map-deletion check. **Still owed (eyeball only):** status bar flips per file, tree groups
  per project.
- **Indexing cost FIXED (0.6.2, branch `perf/indexing`)** — retires the old deferred perf note. On the real 8-project
  `C:\Projects\PLC projects`: startup **11.7 s warm → ~3.5 s** (one scan, not two), archive decodes **306 → 157**,
  `.plcproj` reads 3/project → 1. `TC_Start` 608/427 → 377/388 ms, no regression. **Cold (~20 s) is PROJECTED, not
  measured** — dropping the page cache needs admin; only the byte counts are hard evidence.
  The four invariants and their gates are in DEVELOPMENT.md **"Indexing cost"** — read that before touching this.
  Two that will bite hardest if forgotten: **never teach `custom/reindex` to skip** (on a `.plcproj` change the roots
  are unchanged, the CONTENT moved), and **never add `_libraries` to `SKIP_DIRS`** (`collectArchives` walks it —
  ~171 false positives). Subtlest: a cached signature parse **must be cloned** per project — the merge rewrites
  `record.namespace` and `indexBrowserCache` pushes onto the stored object; `test_signature_cache.js` asserts by
  object IDENTITY because a value check still passes while sharing.
  **Latent:** `scanController` records completion in a microtask after `await scan(...)` — safe only while the scan
  is synchronous. Making it async needs in-flight de-duplication or two `ensureScanned` calls both scan.
  **Deliberately NOT done:** non-blocking/chunked scan with per-project readiness (biggest remaining win, and the
  only route to granular `3/8` progress — but it rewrites the multi-project spine, and a wrong readiness gate
  answers against a partial index = false diagnostics); persisted cross-session archive cache (cold → ~5-7 s; a bad
  entry goes sticky across restarts, needs FORMAT_VERSION discipline, ship the ZIP-central-directory fingerprint
  with it). Next cheap cut: memoize `collectSignatureFiles` per root — signatures are still ~850 ms/scan, now mostly
  16 directory walks rather than parsing.
  **Deferred by decision:** the Libraries view falls back to the **union** of all projects when no `fileUri` is
  sent, because scoping it naively made the view render **empty** even with one project — revisit only if the host
  is taught to send the active file.
- **Publication:** history was rewritten + the GitHub repo recreated to purge customer/vendor content (`sample/`,
  `.trust-lsp/`, machine codenames). Repo is **Private**.
  **Full re-sweep 2026-08-17** — working tree + all 125 commits + all 823 unique non-Monaco blobs. **Content is
  clean**: no emails, `C:\Users\` paths, UNC paths, keys/tokens, or NDA markers anywhere in history; every IPv4 is
  an RFC 5737 placeholder or a library version; no customer-named path ever existed; 0 dangling objects; the
  committed `.tsproj`/`.xti`/`.tmc`/`.library` carry no AmsNetId, machine name or path.
  Two classes of leak were found and one is fixed:
  1. **FIXED** (pre-rewrite commit `f93a058`; SHA no longer exists — search the log for "synthetic equivalents")
     — seven customer artifacts transcribed into comments/fixtures/docs, two of them shipping in the VSIX. The
     names now in the tree are `Acme*` (vendor library), `Palletizer.Turn*` (HMI text key), `FB_Gripper`,
     `FB_Feeder`, `Modules_bak\`, `ST_Robot_DI`/`E_RobotState`, and `C:\Projects\…` for the dev machine layout.
     **The originals are deliberately not restated anywhere in the tree** — writing them here would undo the
     sweep; `git log -p` has them. Every illustrative property was preserved on purpose: the three-spellings
     library point, the text key that must NOT resolve, the backup dir still sorting after `Modules\`, and the
     space inside the path (which is why `scanController` joins root keys on NUL). Don't "tidy" these back into
     realistic-looking names, and don't reintroduce the originals when describing the change.
  2. **FIXED 2026-08-17 by a history rewrite** — commit metadata, which no content grep sees. 44 commits carried an
     employer email and 50 the dev machine's hostname (a git-default identity). `git filter-repo --mailmap`
     collapsed all authors/committers onto one personal identity and stripped 91 `Co-Authored-By:` and 4
     `Claude-Session:` trailers; `GitHub <noreply@github.com>` stays as committer on the 31 PR merges. **Trees are
     byte-identical before and after** (verified by comparing tree SHAs), 128 commits preserved, suite still 60/60.
     Force-pushed to `main` and `claude/new-session-7yuj17` — **every SHA changed, so PRs #29-#31 now point at
     commits on no branch and any old clone is invalid.**
     **STILL OWED (only the user can do it):** GitHub keeps force-pushed objects reachable by SHA until it GCs, so
     the old emails remain retrievable from a commit URL. **Delete and recreate the repo** from the current clone —
     the same route as the earlier content purge, and the only hard guarantee. Do that before making it public.
  **Open:** confirm the contractual right to open-source the extension. Not answerable from the repo — it turns on
  the employment IP-assignment clause and whether the customer engagement was employer work. The 44 employer-identity
  commits are evidence *against* assuming it; get written sign-off. Note `LICENSE` already asserts personal
  copyright and `package.json` declares MIT, so that claim has to actually be true.
- **The suite is platform-correct now (fixed 2026-08-17) — don't reintroduce a Windows-shaped path assumption.**
  11 of 59 suites used to fail on any non-Windows checkout while CI (`windows-latest`) stayed green. Both copies of
  `uriToFsPath` ended in an unconditional `.replace(/\//g,'\\')`: right on Windows, but on POSIX it ate the root and
  produced `\home\u\a`, so every URI→file resolution silently found nothing. The flip is now guarded on `path.sep`,
  **Windows output byte-for-byte unchanged** (verified against the old implementation over drive-letter, encoded,
  uppercase-scheme, bare-path and empty inputs).
  The mirror image was wrong too: `'file:///' + p.replace(/\\/g,'/')` builds a **four-slash** URI on POSIX, so URIs
  built in one place compared unequal to URIs built in another — fatal for the identity guards. Fixed at all three
  construction sites (`xmlIndexer`, `parser`, `configReferences`) and every test-side helper that mirrored them.
  Two harnesses were also bypassing production: `test_plcproj_scope` indexed from `objectPaths` (the **lowercased
  identity keys**) instead of `objectFiles.values()` — reading a key only appears to work on a case-insensitive
  filesystem — and `test_config_references` hand-rolled its own converter. Both now use the real path.
  `test/test_uri_fs_path.js` guards all of it, written to hold on **both** platforms; its load-bearing assertion is
  a round trip through the real filesystem, which a merely plausible converter cannot satisfy.
  **`.gitattributes` is part of this fix, not housekeeping.** TwinCAT object files are UTF-8+BOM **CRLF** and the
  generator says harnesses and LSP offsets depend on both — but they are stored LF, and only Windows' default
  `core.autocrlf=true` was restoring the CRLF. A Linux/macOS clone got LF and `test/browser/build.js` died on
  "FB_Cylinder no longer starts the way the fixture expects". `eol=crlf` now pins the working tree on every
  platform (blob stays LF, so files still diff line-by-line); archives are marked `binary`. **Never delete it.**
  Browser harnesses take `HARNESS_CHROMIUM=/path/to/chrome` to use a preinstalled browser instead of downloading.
  Both build and pass every functional assertion; each still trips its catch-all "browser reported no errors" on a
  **worker-level 404 that reproduces with the old code too** — environmental, not ours, and not yet chased down.
- **`sample/` is GROUND TRUTH** — correct TwinCAT code (it **builds cleanly in XAE**, user-verified 2026-07-20), so
  every diagnostic on it is a bug. At **zero** against a baseline of **zero** (no slack);
  `test_sample_diagnostics`/`test_typecheck` ratchet it (never raise the baseline).
  It is **wholly synthetic and COMMITTED**, and **CI now runs at `Coverage: FULL`** — `REQUIRE_FULL_SUITE=1` passes
  there. Before this, CI executed ~951 assertions in 4 s and silently skipped the ratchet AND the live-path guard;
  `test_live_path` was running **2 of its 10** tests. Built in two steps:
  `scripts/Create sample PLC project/build-sample-solution.ps1` drives XAE once to produce the
  `.sln`/`.tsproj`/`.plcproj` skeleton (only
  TwinCAT can write those — the on-disk template is a 67-byte stub it expands at insertion time, and hand-writing
  them is what produced a project XAE refused to open), then `scripts/Create sample PLC project/build-sample-project.js` writes the 19 objects
  and **injects** their `<Compile>`/`<Folder>` entries into XAE's `.plcproj`, leaving its identity GUIDs,
  PlaceholderReferences and ProjectExtensions untouched. Both are deterministic/idempotent.
  **Committed:** the solution, the 19 objects, XAE's `PlcTask.TcTTO`, the **`.tmc`** (44 KB, from the XAE build —
  our own types only, no Beckhoff content), and **one MIT-licensed archive** (TwinCAT Dynamic Collections, 479
  symbols) so the ZIP reader / string-table parser are exercised on CI. Provenance in `sample/README.md`.
  **Git-ignored:** the Beckhoff archives (vendor binaries), `.vs/`, `*.bak`, `_CompileInfo*/`, `_Boot/`. Nothing
  asserts on Beckhoff without gating on its presence — **verify any change in BOTH configurations** by moving
  `_Libraries/Beckhoff Automation GmbH` aside and back (it is git-ignored, so move it, never delete).
  **Gitignore trap, hit twice:** a `dir/` exclusion makes every negation inside it unreachable — git never descends
  into an excluded directory. Use `dir/*`. The old blanket `!*.TcPOU` negations also leaked *any* project dropped
  under `sample/`; negations must stay scoped to `TcToolkitSample/`.
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
  one incident file existed in the wild (repaired separately). **Member insertion carried the
  same latent defect and is now fixed** (`insertMemberIntoXml`, shared by create + paste): members anchor before
  the first root `<LineIds>`, `.TcIO` (no LineIds at all) falls back to the close tag, and the splice takes the
  anchor's LINE start — the old `lastIndexOf('</POU>')` also gave 6-space indent, `</POU>` at column 0 and bare
  LF in CRLF files, compounding per insertion. Guarded by `test_xml_member_order` (verified to fail 27 ways
  against the old code); `test_xml_clipboard` had pinned the buggy placement and was corrected. Controllers
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
  — decoys share the exact shape (text keys `Palletizer.Turn1` sit beside real paths in the same GTLO; visu-lib
  names `VisuDialogs.*`) and an unproven edit corrupts the HMI. All these formats carry a **UTF-8 BOM** the LSP must
  strip (VS Code documents exclude it → offsets shift by one). Surveyed and deliberately NOT scanned: `.TcIPO`
  (only `.svg` names), `.plcproj` (already synced by the file-rename step), `.tmc` (generated build artifact).
  Counts above were measured on the old customer sample; on the synthetic one `MAIN` = 1 (the PlcTask PouCall).
- **Insert at Cursor / Insert Definition at Cursor in the OBJECTS tree** (0.7.0, `objectInsertCommands.js`).
  Reported as "the functionality disappeared" — it had not: checked **52 revisions of package.json** across both
  the pre-rewrite lineage (recovered from dangling objects, back to 2026-06-02) and the current one, plus the
  0.5.1/0.6.0/0.6.1/0.6.2 VSIXs — 38 carry the commands, **0 ever gated one on `twincatExplorer`**. They were
  always Libraries-only. **Don't re-litigate that; build on it.** Now added for the project's own objects:
  Insert at Cursor = bare name; Insert Definition = a call template with the object's real parameters, the user's
  chosen shape. `callTemplate`/`PARAM_SCOPES` moved out of `libraryTreeProvider.js` into vscode-free
  `src/insertTemplates.js` so both views format identically (guarded byte-for-byte in `test_object_insert.js`).
  An FB inserts a derived INSTANCE name (`FB_Gripper` → `fbGripper`) because ST calls an instance, not a type;
  functions/programs use their own name; methods/actions insert bare (the instance is whatever the user has).
  Menu group is `1_insert@*`, not `twincat_*` — VS Code sorts context groups lexicographically, so a `twincat`
  prefix would drop them below the create/delete block. All four insert commands now explain themselves when run
  from the Command Palette instead of silently no-oping (that silence is what the report looked like).
  **`// TYPE` comments carry the declaration's initializer** (`// TIME := DEFAULT_ADS_TIMEOUT`) — that is
  `xmlIndexer`'s `variable.type` verbatim; library members never have one, so the Libraries view never showed it.
  Left as-is deliberately: it documents the default. Two lines in `insertTemplates.js` if it ever reads as noise.
- **README.md** = public page (ships); **DEVELOPMENT.md** = build/test/architecture; CLAUDE/HANDOFF/DEVELOPMENT are
  `.vscodeignore`d. Package `npx @vscode/vsce package`. `scripts/` ships (the generator). Stale local branches
  `moe`/`native-editor` un-pushed.
- **Build harness lives in TWO places, synced BY HAND (2026-08-07 — the old TC_Start master rule is dropped;
  the user syncs manually now, so do not re-promote anything automatically).**
  - `scripts/Build PLC project/` — the newer, fuller generation (100 KB `.ps1` vs 45 KB), plus
    `probe-sysmanager.ps1` and `test-activation-target.ps1` which `templates/` has never had.
    **`.vscodeignore`d**, so it does not ship.
  - `templates/` — the older revision that **ships in the VSIX** and is copied into user projects, so it must
    stay **generic**: no local paths, no `TcSample`/sample-generator names.
  **Real identifiers were redacted on the way in** (2026-08-07): `test-activation-target.ps1` hardcoded AmsNetIds
  its own docstring called real (the author's machine and a physical station), `build_plc_project.ps1` had one in a
  comment and `probe-sysmanager.ps1` had one as a **live fallback probe target**. All replaced with RFC 5737
  placeholders (`192.0.2.x` / `198.51.100.x`), preserving the near-miss and same-network relationships the tests
  rely on; harnesses verified **64/64 and 13/13, identical before and after**. Keep it that way — this repo's
  history was purged once already.
  `-ProgId`/`-PinVersion` were removed 2026-07-29 — `-TcVersion` is the single knob and passing it is what
  pins; the traps are in the script's own header, read that. `test-resolve-twincat-target.ps1` is COM-free
  (**13/13**, no TwinCAT needed); `twincat-project-CLAUDE.md` + README are synced to the `templates/` revision.
- **Architecture roadmap COMPLETE** (H1 `features.js` facade · H2 `symbolNode` · M2 injectable index · M3 thin
  `extension.js` → `src/commands/` + `src/xaeShell.js` · L2 perf guard — all merged). **L1 (reverse index) DEFERRED
  by decision** — reference search is already 29 ms cold / ~4 ms warm; reopen only past ~1000 files or >200 ms.

## Diagnostics: how to measure (get this wrong and the number is fiction)
Mirror `server.js`: index libraries up front, then **per file** `convertXmlToSt(parsed,{raw:true})` →
`parseAndIndexDocument(stText,uri)` → `registerLibrarySymbolNodes(index,stText)` → `provideDiagnostics(...)`. Three
traps that have bitten: **non-raw** conversion strips decl-site init lists (`fb:FB_X(a:=b)`→`fb:FB_X;`) and hides
diagnostics; omitting `parseAndIndexDocument` gives methods **stub ranges** → every method-local var reads undeclared
(fabricated ~2,300 phantom diagnostics — the old "2550 baseline" was fiction); omitting `registerLibrarySymbolNodes`
→ 171 false positives **on the old customer sample**. `test/_baseline.js` is truth. Against the synthetic sample every
producible row measures **0** (`archives-only` and `none` measured, and they agree — proof its code names no library
symbol at all); the `.tmc` rows are labelled inference, not measurement, because a `.tmc` only appears after a TwinCAT
build. Re-measure rather than trust the table if one ever lands.

## External symbols: five sources, all load-bearing (`libsymbols.js`)
~32k symbols on a large real project (1551 on the synthetic sample), ~200 ms, registered into the index **on demand, per document** — registering all up front took the
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
  Types". struct/enum/alias share ONE "DUT" TypeGUID (`ST_Robot_DI`==`E_RobotState`==`{2db5746d}`), DUT nodes carry
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
**Duplicate object names from orphan files** (0.3.0 rename smoke, real project): a leftover `POUs\Modules_bak\` backup —
a full copy of `Modules\`, NOT in the `.plcproj` — won the name-keyed index (last-write-wins, sorts last), so a
GVL rename's reference scan visited the orphan `FB_Feeder` (no refs) and never the real one; visu updated because it
walks files directly. Fixed: the index is **scoped to the `.plcproj`** — each project's `objectPaths`
(`createProjectMap`, `projectMap.js`) lists only what it `<Compile>`s, so an on-disk orphan is never indexed. The
original fix used `collectPlcProjObjectPaths`, which unioned every `.plcproj` into one set; that union is exactly
what made multi-project workspaces collide, and it was **deleted** when the partition landed. `indexTwinCatDirectory
(index, dir, includedPaths)` survives for the no-`.plcproj` fallback (null set = index all). Sample has 0 objects
outside its `.plcproj` → the gate is a no-op there, ratchet safe (`test_plcproj_scope`). NOT scoped: `.st`
(`indexStDirectory`, which now routes per file) and the visu walk — neither hit the duplicate-name bug.

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
  **Three grammars must agree on this and two did not** (user report 2026-08-10, fixed 0.6.3): the Monarch
  tokenizer and `syntaxes/twincat-st.tmLanguage.json` both carried C-style `\\.` escape rules copied from Monaco's
  sample grammar, so a Windows path `'C:\Temp\x\'` ate its own closing quote and highlighted as a string until the
  next apostrophe anywhere below (the reported case: an `FB's` in a comment 16 lines down). The lexer was always
  right. `test_st_strings.js` now pins all three together; `run_pragmas.js` proves it through Monaco's own
  tokenizer. A `@wstring` state was added at the same time — the webview never tokenized `"`-quoted WSTRINGs.
- **Go to Definition must carry pane + localLine, like references already does** (same report, fixed 0.6.3).
  The LSP returned the correct range all along, but the webview threw it away: `openGotoTarget` passed `null` and
  the same-component branch of `provideDefinition` used `findWordInPanes` → `matches[0]`, so F12 on `bDone` landed
  on the first `bDone` in the FB's header comment instead of its declaration. `custom/definition` now maps the
  absolute unit range through `absoluteToLocal` (the shared `createStResolver` handles a cross-file target) and the
  webview selects that exact location, keeping the line- and word-search fallbacks for stale content.
- **Multi-interface inheritance:** `INTERFACE EXTENDS I_A, I_B` — nodes carry **`extendsAll`** (array; `extends` stays
  the first parent); EXTENDS walkers traverse the DAG breadth-first. `test_interface_multi_extends`. FBs/structs stay
  single-inheritance.
- **Libraries view:** row label is the **namespace** (three spellings differ); `indexLibraryTitles` runs twice per
  pass (keys `kind|include|namespace` or entries double); resolve `symbolCount`/`types` **lazily**; a `.plcproj`
  change must `custom/reindex` **then** refresh; TwinCAT files are webviews (no `activeTextEditor`) → Insert routes
  via `insertTextIntoActivePanel()`.
- **Autocomplete is caret-context aware** (`classifyCaretContext`): `x:▮`→types+namespaces (no `END_IF`); `x:=▮`→
  values; call parens→params first. **Unknown context ⇒ full list, never nothing.**

## Webview browser harness (`test/browser/`, needs `npm i --no-save playwright`)
The only test of `media/editor.js` — **run both runners whenever it changes**. `run.js` (references peek,
17 assertions), `run_pragmas.js` (folding + Monarch pragma scopes, 29). Every guard verified to FAIL,
not just to pass. DEVELOPMENT.md documents both. Outside `npm test` on purpose (needs a browser) and safe
there: `test/run.js` only discovers top-level `test/test_*.js`. Moved out of `scratch/` 2026-08-05, which
is now **git-ignored** — a local playground, so anything worth keeping must live in `test/` or `scripts/`.
**Navigating away must DISMISS the peek** (0.4.1; user found it, dev-host, reported as "the arrow on top of the
peek window disappears"). Monaco dismisses a peek itself when a reference opens in the same editor; it cannot
here, because a hit outside the active component round-trips through the extension host
(`openFile` → `twincat.openComponent` → `selectComponent`) and Monaco never learns it happened. The visible
half is the ARROW: it is a decoration, so `loadComponent`'s `setValue` drops it, while the zone widget is not
and survived — a peek with no arrow, hovering over content already replaced underneath it. Closed in BOTH
places, and both are needed: `loadComponent` (same file) and `openPeekTarget` (cross-file never returns
through `loadComponent` at all). Dev-host still worth a pass on the real bridge round-trip.

## Pragmas + folding (0.5.0, 0.5.1)
Shipped: `src/lsp/pragmas.js` + two catalogs, category-scoped highlighting in **both** grammars,
`{region}`/`{endregion}` folding, and attribute-name completion. Findings worth not re-deriving:
- **Infosys is authoritative but NOT exhaustive**, which is why there are two catalogs and why shape
  matching is the base tier. Measured here: `TcGenerated` in **150 of 337** installed library archives,
  `object_name` in 59 archives / **40** uses in real project code, plus `no-analysis` (155), `message_guid`
  (102), `vtable_order`, `old_input_assignments`, `contains_no_copy`, `variable_length_array`,
  `implicit_input` — **none on any Infosys attribute page**. `checks_in_libs` did NOT reproduce (0 hits);
  don't re-add it without measuring. Method: read each archive's `__shared_data_storage_string_table__`
  via `libsymbols.js` — note `readZipEntries` takes a **Buffer, not a path**, and a try/catch around it
  silently yields "no hits" (cost one wrong conclusion).
- **Shape decides colour; the catalog only enriches.** A user-defined attribute must be scoped exactly
  like a documented one — TwinCAT documents user-defined attributes as a feature, so tinting an
  uncatalogued name would be a diagnostic in disguise. Pinned in `test_pragmas.js` and the browser harness.
- **Folding is ours now (`media/stFolding.js`, 0.5.1), not Monaco's.** Markers alone shipped in 0.5.0 and
  the user found two bugs in a day, both artefacts of Monaco's **indentation** folding — the wrong model
  for a keyword-delimited language: (a) an unmatched `{endregion}` truncated the enclosing VAR fold —
  `computeRanges` scans bottom-up and pushes an `{indent:-2}` sentinel that ONLY a matching start marker
  pops, so a lone end marker is a permanent barrier; (b) `{attribute 'TcLinkTo' := ''}` at column 0 under
  an indented VAR body grew its own fold arrow — nothing to do with pragmas, any unindented line did it.
  A `FoldingRangeProvider` **replaces** the indentation provider outright, so stFolding.js must cover the
  keyword blocks (VAR family, IF, CASE, FOR, WHILE, REPEAT, STRUCT, UNION, TYPE) as well as regions or
  `IF … END_IF` silently stops folding — asserted in a browser for that reason. Keywords count only where
  they are CODE: `{IF defined(X)}` is a conditional **pragma**, and reading it as an IF leaves an unclosed
  block that eats every fold below. Regions and blocks use **separate stacks** so one malformed construct
  cannot destroy the other. Registered twice from one dual-mode file (webview `<script>` + `require`) —
  `.st` files in VS Code's own editor had both bugs too. The `folding.markers` in editor.js and
  language-configuration.json are now **inert**, kept as declarative fallback and pinned by test_pragmas.
- **The tmLanguage grammar had NO pragma rule at all** and therefore the same apostrophe bug the Monarch
  tokenizer was fixed for. `#pragmas` now precedes `#strings`.
- The generator (`scripts/fetch-pragma-catalog.js`) is **run by hand only** — offline constraint. Behind
  this machine's TLS-inspecting proxy plain `node` fails with "self-signed certificate in certificate
  chain"; use `node --use-system-ca`.
- Deliberately NOT done: the lexer's Pragma token is still unclassified (nothing consumes it; `tokenize`
  runs over every file on every diagnostics pass), and there is **no hover** — it would need a new
  provider round-trip the catalog does not justify yet.

## Working agreement
Implementation is delegated to the **`implementer`** agent; the main conversation owns architecture/planning/review/
commits. **Verify every agent claim** (several haven't survived checking); agents run in parallel only with strictly
disjoint file ownership; `package.json`/`HANDOFF.md` stay centrally owned. **Verify your own claims too** — three
times an unmeasured but plausible assumption was wrong. Measure, then report.
**Hard-won lessons live in `.claude/memory/`** (committed, so they cross machines), injected each session by the
`SessionStart` hook in `.claude/settings.json`. Write new ones THERE, not in the per-machine bank — rules in
CLAUDE.md. Note `autoMemoryDirectory` cannot do this job: it is **ignored from a checked-in settings.json** by
design, which is why this is a hook. The five original notes were migrated out of `~/.claude/…/memory/` 2026-08-05.
