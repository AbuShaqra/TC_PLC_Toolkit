# HANDOFF

Where the work *stands*. Read before starting; keep current (handoff rule in [CLAUDE.md](CLAUDE.md)). Target under
500 lines (user ruling 2026-11-09) — prune finished items rather than appending, but never drop a real finding to hit it. **Shipped features
live in git history (PRs/commits); the findings that would cost to re-derive live in
[docs/handoff-findings.md](docs/handoff-findings.md)** — read the section covering what you are about to touch.

## Status
- **Released:** `package.json` is at **0.10.1**, and **v0.10.1 is PUBLISHED** (2026-11-03 16:13 UTC: dev→main PR #23
  merged at `3210d33`, Release run 41671593015 green, VSIX `twincat-plc-toolkit-0.10.1.vsix` attached).
- **Version history:** 0.10.1 struct EXTENDS from own DUTs (PR #22); 0.10.0 Libraries scoping (PR #18); 0.9.0
  improvement-plan phases; 0.8.x project-aware Generate ST, ResizeObserver fix, solution→project Objects tree.
- **Last verified:** 2026-11-09 (Linux container, `claude/focused-ptolemy-m6acaz` with R2 phase 1) — `REQUIRE_FULL_SUITE=1 npm test`
  green (**89/89, Coverage: FULL**), `npm run typecheck` and `npm run lint` exit 0; all three browser harnesses green
  (`run.js`, `run_pragmas.js`, new `run_start_page.js`; Chromium via `HARNESS_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`).
  The dev-host harness was last run on Windows 2026-11-09 for R4; its new R2 start-page phase has never run.
- **Sample diagnostics: 0 against a baseline of 0** — verified with the Beckhoff archives present AND moved aside.

## Branching, CI and repo settings
- `dev` collects day-to-day work; a release is a `dev → main` PR, then the manual *Release* workflow on `main`
  (procedure: DEVELOPMENT.md "Publish a GitHub release"). `dev` has no ruleset — direct pushes are allowed.
- **CI is PR-only** (`ci.yml`, `pull_request: [main, dev]`): lint → typecheck → `npm test` with
  `REQUIRE_FULL_SUITE=1` (a REDUCED run fails), plus a VSIX build check (ruled: "releasable" includes "packages").
  Direct pushes to `dev` trigger nothing; use *CI (manual)* (`ci-manual.yml`, `ref` defaults to `dev`).
- Ruleset `main-1` on `main`: PR required, **0 approvals**, no bypass list, **no required status checks** — a red
  CI does not block the merge button (adding the `build` check is the one change that would). Actions permission
  is `selected` + GitHub-owned (`local_only` killed every run with `startup_failure`). Confirm a run's real
  conclusion before trusting a badge; scan workflow YAML bytes before pushing
  (`.claude/memory/workflow-yaml-needs-a-byte-scan.md`).
- Repo is **Private**. History was rewritten twice and the repo deleted-and-recreated 2026-08-26; that sweep is
  complete. Before any future sweep read `.claude/memory/leaks-hide-in-metadata-not-content.md`, and never restate
  the original names that the synthetic ones (`Acme*`, `FB_Gripper`, `Modules_bak\`, …) replaced.
- **Stale remote branches:** `claude/new-session-ynrdo4` and `claude/project-thread-o6i1sa` are merged into `dev`
  (checked 2026-11-09). The user asked to delete them, but this cloud session's git proxy drops every push
  except to the session branch, so they still exist — delete from the GitHub UI or a local clone.
- **Merge `claude/focused-ptolemy-m6acaz` into `dev` by SQUASH only, every time** (PRs #27, #29 so far): after PR #27 the branch was
  restarted from `dev`, but force-pushing was refused, so the old branch was merged back in (no file changes);
  its history still holds commit `2b06874` with a `Co-Authored-By` trailer that must never reach `dev`.
- **Merge `ccr-d5b51254-r1vu2b` into `dev` by SQUASH only** (user decision 2026-11-09): commit `65d5b1c` on it
  names a private repository the user wants kept out of this repo; the final tree is clean. Delete the branch after.

## Start here (next session)
- **R5 + R1 are MERGED into `dev`** (PR #27, `0ea9fcd`) and their **Windows/XAE check PASSED** (user, 2026-11-09:
  accessor add/re-add opens and builds in XAE, `node test/devhost/run.js`, menu pass). That pass found the multi-project
  Generate ST menu clipped in a narrow editor (right-aligned to the caret → ran past the webview's left edge; long names
  scrolled sideways): fixed in `3b93ef1` (`placeGenerateMenu` in `media/editor.js`, ellipsis + tooltip;
  `test/browser/run.js` 7c checks 360/560/1200 px, all three failed before). Still owed: reply on issue #25 when it
  ships in a release. User request 2026-11-09, done: a tri-state *Select all* in that menu (`#generate-st-all`,
  `syncSelectAll`; "Generate selected" disabled while nothing is ticked; harness 7d).
- **R3.1 spike findings are DONE** (2026-11-09): `docs/r3.1-strucpp-spike.md`. Headline: 27 parse errors as
  converted; 1 converter cause (methods/properties emitted after the POU body — the compiler wants them first) +
  9 compiler gaps; with scratch workarounds 0 errors under twincat3, 6 under iec (REFERENCE TO, REF=). No
  check-only CLI flag (`analyze()` is check-only but unreachable from the CLI bundle; a wrapper or a fork
  `--check --json` flag). Export-mode input is WRONG to check (it rewrites REFERENCE TO→POINTER TO, REF=→:=);
  R3.2 must feed a raw-based unit. **Decided 2026-11-09:** wait for the fork (fork-lane item S2, before R3.2;
  the roadmap now has a parallel STruC++ fork lane: S1 language-server dialect profiles — DONE, fork PR #4
  `a529ea9`, client contract in its PR body; S2 compiler gaps: plan DONE and decided 2026-11-09 —
  `docs/s2-strucpp-fork-plan.md`, all 13 steps + 1b (~22.5 d), `iec` = Ed. 3, Annex A precedence). Merged in the fork: step 1
  (`--check --json`, lexer positions; PR #5 `8aea9a7`) and 1b (`iec` renamed `iec-3`, no alias, id reserved; PR #6
  `5fda1bc`). Step 2 (pragmas skipped with a warning, conditional ones refused; PR #7 `47c99fa`) also merged — the toolkit's
  check (R3.2) can now analyse every sample file. Step 3 (`SUPER.` always on, `THIS^` behind `self_caret`; PR #8
  `db0f53c`) merged. Step 4 (member-chain method calls; PR #9 `19f91a7`) merged. Fork follow-ups found
  along the way, not yet scheduled: plain `SUPER()` body call; `SUPER.x :=` as a target; `p^.M()` (C++ for an FB behind
  REF_TO does not build); single-dot `inst.Nope()`/`intVar.M()` pass the checker and fail only in g++; positional
  method calls that omit a VAR_OUTPUT fail in g++; an unknown member in a chain (`x := mid.nothing`) is not flagged.
  Step 5 (interface-typed variables, `IEC_ITF<I>`; diamonds via virtual inheritance on shared edges only; PR #10
  `c5ee894`) merged — not yet: ARRAY OF / STRUCT field of interface type, properties through an interface variable.
  Step 6 (interface PROPERTY behind `property`, explicit GET/SET; PR #11 `5b99425`) merged = **release B**.
  More fork follow-ups: `THIS.a.b` does not parse; an FB that IMPLEMENTS an interface only through a base FB's
  methods/properties passes analysis but fails g++; IMPLEMENTS ignores methods from interface EXTENDS bases;
  an FB property inherited from a base FB fails in g++ when used on the derived instance. Step 7 (chained comparisons, Annex A; PR #12 `5fde942`) merged.
  Step 8 (`postfix_enum_base`; PR #13 `da78fe3`) merged. Also found: `TO_DINT(enumValue)` fails in g++ (pre-existing).
  Step 9 (`named_global_lists`; PR #14 `fafc02e`) merged. List = file stem, override `--global-list <file>=<name>` /
  API `globalListName`; a local may hide a global (`GVL_A.x` still reaches it); the same name in two lists is allowed
  (plain use must be qualified). R3.2's converter must pass each GVL's name. Also found (pre-existing):
  `gfb(a := 2);` on a top-level global FB fails in g++; bundled-library global `speed` collides with a user global;
  `--feature` help text and DIALECTS.md "Checks" list stale; `GVL_A.units[0]()` does not parse; lexer accepts `a__b`.
  Step 10 (`struct_extends`; PR #15 `a962890`) merged: flattened in the AST; derived↔base assignment and arguments
  refused (6.4.4.6); a library STRUCT as base refused for now (manifests carry no initial values). Also found
  (pre-existing, plain STRUCTs): unknown member `s.zz` unflagged in ST; `POINTER TO ST := ADR(s)` refused;
  `REF(s)`/`REF=`/STRUCT `=` fail in g++; unrelated-STRUCT arguments unchecked in ST (fail in g++).
  Step 11 (`union` parse + analysis; PR #16 `337817f`) merged: contextual (no new tokens, `union` stays a name);
  STRING members allowed; initial values refused as "not supported yet" (possible R3.2 false positive); compile()
  refuses UNION until step 12. Found (pre-existing): a STRUCT alias is not assignment-compatible with its STRUCT;
  `STRING[n]` does not parse (B6, use `STRING(n)`). Step 12 (UNION C++ lowering; PR #17 `fd19d10`) merged: raw byte storage
  + memcpy views, STRING reads bounded; UNION left out of the debug table; RETAIN/REF/REFERENCE TO/library-STRUCT in a
  UNION refused at compile only. Found (pre-existing): POINTER/REF to a whole STRUCT does not compile; a library
  function's plain VAR locals are exported as inputs; no LEN for WSTRING; SIZEOF of STRUCT counts wrapper overhead.
  Step 13 (`fb_init`; PR #18 `635c962`) merged — **all 13 S2 steps done**. Rules (user, by card): FB_init once per
  instance after initial values, before the first cycle; globals first, then programs; nested before holder; flags
  FALSE; inheritance = base-first chain (explicit SUPER.FB_init refused at compile). User's TwinCAT finding: an
  interface passed to a nested instance through the holder's FB_init page-faults in TwinCAT (nested inits first);
  the fork binds a member's init arg naming a HOLDER FB_init input to the holder's instantiation value (works), and
  warns when an init arg reads a holder member the holder's FB_init assigns. Ed. 3 cannot express the pattern
  (6.5.1.3: initial values are literals/constant expressions). Found (pre-existing, before S2 too): a method named
  `Get` is a parse error (added to S3a); `x : INT := zz;` passes analysis; a global `LOG` clashes in C++.
  Release C note posted in the coordination doc. Folded item 1 (`REFERENCE TO` inputs bound at the call; PR #19
  `f422ad1`) merged: FB call wrote through an unbound ref (SIGSEGV); fn/method calls did not build. Newly refused
  (feature on): literal/expression/constant/other-type/REF_TO-without-^/subrange args. Alias-typed VARIABLES are not
  IECVar-wrapped → binding/REF= to one refused at compile only ("not supported yet"); wrapping them ~1.5–2.5 d (S3b).
  Remaining folded items measured: (a) FB VAR_IN_OUT by reference ~5 d (changes the bundled softmotion .stlib C++);
  (b) typed TRUNC_<type> ~1 d (passes --check, fails g++, even under iec-3); (c) plain TRUNC→DINT, feature
  `trunc_dint` ~0.5–1 d; (d) `:= 0` on an interface, feature `interface_zero` ~1 d — `itf = 0`/`<> 0` already pass in
  every dialect incl. iec-3 (decision: keep them always on?); (e) PROGRAM method from another POU ~3–4 d, needs an
  instance-model decision. Also found: undeclared function calls pass --check; side-effect call order not
  left-to-right; positional FB inputs counted differently by analysis vs codegen; REF= source unchecked.
  Typed `TRUNC_<type>` merged (PR #20 `5d969b3`); `trunc_dint` merged (PR #21 `904ca42`; the CLI `--feature` help is now
  derived from KNOWN_FEATURES, so it no longer goes stale); `interface_zero` merged (PR #22 `d76fc91`). Found: a STRUCT
  field `f : I_A := 0` is accepted everywhere and fails in g++ (interface STRUCT fields: S3b). PROGRAMs reached by name
  merged (PR #23 `7d65d10`, behind `program_methods`): one shared instance only for programs reached from another POU
  (inline header object; config/debug table/REPL/test harness bind to it); narrowed: `PRG_A();` without the feature
  and a program calling itself (both failed g++ before). Found: `p : PRG; p();` on an unreached program fails g++;
  `PRG_A.x` inside PRG_A refused; VAR_OUTPUT written via VAR_IN_OUT/ADR not flagged; cross-task calls unsynchronised.
  **S2 DONE** — FB VAR_IN_OUT by reference merged (PR #24 `b286bc2`, 23:17 UTC); was:
  FB VAR_IN_OUT by reference (last folded item, ~5–6 d). Design measured: only FBs copy in-outs (functions/
  methods already T&); fixes inherited in-outs never written back, ARRAY[*] in-outs not compiling, positional in-outs
  dropped; 0 corpus outputs change, the bundled softmotion/oscat-basic .stlib do. Decided 2026-11-09: always on
  (user); CONFIGURATION globals by reference in every build with a threaded-build warning (user); new in-out checks
  are warnings by default/vendor profiles and errors under iec-3, while literal/expression/bit-access args are errors
  everywhere (user); manifest marker `inoutByReference` with a legacy fallback; outside read of inst.inout allowed,
  outside write per the strictness rule; stack-rooted bindings unbound after the call. Found while doing it
  (pre-existing): CONCAT on WSTRING fails g++; alias-typed PROGRAM vars without an init value are never initialised;
  REF()/ADR() of a CONFIGURATION global fail g++. Release D note posted (coordination doc). S3a running, one PR per item: signed typed literals +
  typed CASE labels merged (PR #25 `0f7c1d0`); GET/SET as identifiers merged (PR #26 `cf320b7`); STRUCT/UNION alias = same type merged (PR #27 `554c409`); ADR into POINTER TO STRUCT/UNION/FB merged (PR #28
  `8851856`); UNION one-member initial values merged (PR #29 `bc171d0`) — **S3a DONE**. S3b batch 1 running (10 defects that pass the
  check but run wrong or fail g++): omitted function/method inputs take their declared default (PR #30 `4e245bf`;
  also fixed positional method calls omitting a VAR_OUTPUT); undeclared functions reported (PR #31 `c911311`; a
  198-name runtime-function list synced from the headers by a test keeps runtime helpers like TIME_TO_US accepted;
  units with `{external}` are not checked); unknown method calls reported (PR #32 `371ac37`; `inst.sub()`, a STRUCT-held
  FB `s.f()`, `rr.M()` and library `tn.M()` stay accepted — the last two fail g++, logged); unknown members and
  array↔single-value assignments reported (PR #33 `bf457f1`; `w.C3` bit-by-constant stays accepted, fails g++). Found:
  inherited PROPERTY read on a derived FB fails g++; POINTER TO ARRAY OF BYTE over ADR(dword) reads 0. Unknown
  STRUCT-initialiser elements reported (PR #34 `db25cb3`; an unused TYPE-level default stays accepted). Undeclared names in initial values reported
  (PR #35 `17ee57a`); a bare member of several enums is now settled by the target's enum type and emits `E1::B`
  (widening). Found: `E2#B` with an enum named E2 lexes as a numeric literal. Return variable wins over a same-named enum member
  inside its own body (PR #36 `bfe50d5`). Globals named like runtime-only helpers emitted as `NAME_` (PR #37 `6e2a520`;
  204-name set re-derived from the headers by a g++ test; `LOG` with libs stays an analysis refusal). `TO_<type>` of enum values builds (PR #38 `b6dffeb`, runtime-only). Unrelated STRUCT arguments to
  VAR_INPUT/VAR_IN_OUT reported (PR #39 `852d856`; library STRUCTs not checked). **S3b batch 1 DONE** (10 PRs). S3b batch 2 running (accepted code that fails g++ → make it
  build): FB calls on member/global instances + `w.C3` + `fbb : FBB` method calls (PR #40 `4dd4750`); a PROGRAM-typed variable call runs its body
  (PR #41 `a1bbdfd`). Inherited properties + bare (own and inherited) property names merged (PR #42 `0f34ef2`) — the
  bare-name case was a false "Undeclared variable" on correct code. Interfaces implemented through a base FB build
  (PR #43 `186a633`); narrowed: interface methods inherited via EXTENDS are now required (failed g++ before). REF/REF TO of STRUCTs and FBs (PR #44 `6e80c81`); calls through a reference or pointer (PR #45 `f190895`); STRUCT `=`/`<>` memberwise, no feature (PR #46 `20be61c`); string functions on WSTRING (PR #47 `36142fd`); `a.b.fb()` (PR #49 `4e5bb64`, #48 closed: stacked-squash conflict, replayed as a `-r` branch); library FB methods in the manifest (`methods`, old archives fall back; PR #50 `3997211`) — **S3b batch 2 DONE**. INSERT/WINSERT now insert after the first P characters, as IEC says (**user 2026-11-10**; PR #51 `15b4ea5`; run-time behaviour change, C++ byte-identical; OSCAT LIST_INSERT/REAL_TO_STRF now right — list it as a behaviour change in the release E note). Found: `INSERT('ABC','XY',1)` with two literals fails g++; `inst.sub(zz := 3)` unchecked, fails g++; REF() of STRING/WSTRING/enum fails g++. Batch 3 running, one PR per item, merged before the next starts: unknown named args on FB instance calls (plain/member/chain) refused in every mode (PR #52 `092636c`; was `--strict`-only, all failed g++). **Decided 2026-11-10 (user, by card): a named argument binding an FB's VAR/VAR_TEMP local is always an error** (batch 3 item 11; #52 had kept it). Found: FB named like a std function (`Sub`) fails g++; unknown named arg on a method call silently dropped. REF()/REF= of STRING/WSTRING/enum (PR #53 `00d854d`, header-only); the nine string functions with literal args + CONCAT of 3+ any-form args (PR #54 `0e80a0d`, header-only); `TYPE E2 : (A,B) := E2#B` parses and an enum type default must be its own value (PR #55 `c0d7bb7`; `E2#B` was never mis-lexed). **Decided 2026-11-10 (user, by card): byte access through a differently shaped pointer runs wrong (IECVar<T> = {value_, forced_, forced_value_}, so a BYTE is 3 bytes) — refuse the detectable forms now (batch 3 item 5), redesign the layout later (new S9).** Superseded the same day: the refusal hit 14 bundled OSCAT functions (FIND_CHAR, MIRROR, LIST_* …: `POINTER TO ARRAY OF BYTE := ADR(str)`, reading 'abcdef' as 99 102 0 today) and would stop `oscat-basic` building; **user: "fix the root cause" → S9 runs right after batch 3 item 7, ahead of S4–S8; refusal dropped.** Item-5 refusal WIP kept locally only, unpushed, on fork branch `bugfix/refuse-pointer-reinterpret` (8633110). `PRG_A.x` inside PRG_A (PR #56 `a13e5cb`, an AST lowering under program_methods); alias/subrange vars value-initialised (PR #57 `55ad29b`; only C++ diff in corpus: subranges.st, type_aliases.st headers). **Release E = development `55ad29b`; note posted in the coordination doc 2026-11-10.** S9 design done and approved (scratchpad `s9/DESIGN.md`, 448 lines; prototype runtime: unchanged generated C++ compiles, all repros + 7 OSCAT functions right, integration 641/5 fail = forcing stubs only). Design: `IECVar<T>` = one `T value_` (sizeof==T, `__may_alias__` + `-fno-strict-aliasing` as backup — required, -O2 miscompiles REAL↔DWORD/STRUCT-bytes punning otherwise); STRING = `char[N+1]`, length by `memchr` (LEN ~10× slower, CONCAT/assign faster); enums `: INT_t`; forcing → bounded table `iec_force.hpp` (64+8 hosted, 16+1 AVR, macro-overridable; my call), applied by an RAII `ForceScope` in generated `run()` at cycle start and end. **User 2026-11-10: accept PLC-style cycle-boundary forcing** (a program write to a forced var wins until cycle end). Steps S0 (library manifest listed FUNCTION locals as inputs) → S1 force table → S2 codegen → S3a forcing consumers (debug dispatch, REPL, extension gdb force) → S3b layout → S4 STRING → S5 OSCAT real-call e2e; one PR each; ~1550 + 2200 LOC. Release F note must list: forcing semantics, SIZEOF now PLC sizes (STRING(80) = 81, ARRAY[0..3] OF BYTE = 4), embedded $00 truncates a STRING, force-table bound + status 0x88. Runtime CMake tests are not in CI (run by hand per step). Merged: S0 (PR #58 `27df278`: FUNCTION manifests list only inputs/outputs/in-outs; oscat-basic 160 functions lose 448 local entries; C++ identical) and S1 (PR #59 `97fd6ca`: `iec_force.hpp`, unused until S3a) and S2 (PR #60 `2bc66eb`: `force::Scope` in every PROGRAM run(); enums without a base `: INT_t`/DINT via `implicitEnumBaseName()`, fixing a debugger enum-force bug (4-byte int vs 2-byte tag); `debug_array_kind[]`; empty force table costs 4.3 KB hosted / ~393 B AVR until S3b packs). Release F note also: enum SIZEOF now 2. S3a merged (PR #61 `c5573aa`): dispatch/REPL/extension force via the table, status 0x88, force API removed from the wrappers (C++ API change), `strucpp_force_capture`/`strucpp_unforce` exported for gdb; C++ output identical; 12-point behaviour list for release F is in the PR body. **Manual tests owed by the user (fork rule):** force/unforce from the editor debugger against a threaded runtime and an Arduino build, and VS Code "Force Variable" under gdb. Separate item also: `test_iec_composite.cpp` does not compile on development. **S9 DONE 2026-11-10 12:05Z** (S5 = PR #64 `e071f4f`: 14 pointer-based OSCAT functions + CHR_TO_STRING/UPPERCASE/BYTE_TO_STRH through real calls at -O0/-O2). **Release F = development `e071f4f`, note posted in the coordination doc.** User 2026-11-10: keep STRING(n) = n+1 bytes (IEC §6.4.2.2 / Table 10 note k leave storage to the implementer; n+1 = vendor layout, needed by OSCAT). Part A item 1 merged (PR #65 `1578375`): user declarations shadow bundled-library symbols (user global `speed`/`MATH` was an analysis error; user `TYPE SR`/FB SR/`TYPE SPEED` failed g++); refused only when a used library block depends on the shadowed name (e.g. user R_TRIG + library CTU); a variable read seeds only library globals/types; 11 corpus programs that failed g++ now build. Items 2+2b merged (PR #66 `379e355`): FB/INTERFACE/TYPE/FUNCTION named like a runtime function emitted as `NAME_` (rename in compile() just before codegen; ST names kept in diagnostics, debug map, REPL; library builds keep names via `cppNamesAsDeclared`); a user FUNCTION `Max` now wins at its call sites (run-time change: it ran the standard one before); 24 typed truncations added to the runtime name set. Item 3 merged (PR #67 `d0cb38d`): unknown named args on method calls (instance/THIS/SUPER/bare/PRG.pm/interface/REFERENCE TO) are an error (were dropped with a warning); C++ identical. Item 4 merged (PR #68 `8e65a12`, user decision applied): a named FB argument may name only VAR_INPUT/OUTPUT/IN_OUT — VAR, VAR_TEMP, CONSTANT, EXTERNAL, method/property/action are errors in every mode; nothing in tests/examples/libs relied on it; C++ identical. Item 5 merged (PR #69 `e838f79`): library FUNCTION named args bound by name + declared defaults for omitted inputs (run-time change: a named call in another order bound by position before; AIN ran with swapped args); C++ identical. Item 6 merged (PR #70 `56c9429`): a POU ARRAY OF enum uses the enum variable wrapper as element (REF of an element, array ↔ STRUCT-field array assignment, ARRAY[*] in-out all failed g++); C++ identical. **User 2026-11-10: use Fable 5.2 for agents (free allowance) — launch with `model: "fable"`.** A Fable agent took over at item 7 with Parts A–D (items 7–14, 3b, 3c, 5b; batch 4 = 15–21; runtime tests = 22; batch 5 = 23–30); gate scripts in scratchpad `b5/`. Item 7 merged (PR #71 `8f3a546`): STRING length kept behind REF_TO/POINTER TO/REFERENCE TO and type aliases (`TYPE TS10 : STRING(10)` was 254 chars — run-time change); cross-length REF_TO assignment refused both ways (narrows `p10 := REF(defaultString)`, which built only because the length was dropped; my call: unsafe otherwise). Item 8 merged (PR #72 `b8aa14e`): NOT fixed by S9 — INSERT/REPLACE returned IN1's declared length (wrong results when IN1 is the shorter), CONCAT of 3+ folded pairwise, nested mixes failed g++; now generic templates sized for the longest argument; a literal = default STRING (so `INSERT(s5,'XYZ',2)` → `ABXYZ`, was `ABXYC`); run-time changes for the release note. 8b queued next (my call, runs wrong): string function results are full-length (254), truncation only on assignment (`CONCAT(a5,b5)` into STRING(10) gave 5 chars). Added 7b (array element STRING length), 7c (REF= unchecked), 7d (REF_TO alias vs base length), 7e (LEN on a named STRING type: compile() vs CLI). Added 5b (library REFERENCE TO inputs; manifest lacks the kind). Added 3b (user and library FUNCTION unknown named arg) and 3c (interface method signature mismatch → abstract class, fails g++). Next running: S3b batch 3 leftovers (Part A, 14 items), batch 4 (Part B, items 15–21: the coordination doc's rows 14–16, 18–20, 25), then Part C (runtime tests into npm test, the 4 CMake failures, test_iec_composite.cpp) — one PR each, merged before the next. Post-S9 list: 4 CMake failures, CMake tests into npm test/CI, `test_iec_composite.cpp`, library named-arg ordering, threaded forced-global race, optional cleanups (UNION proxies, FOR bound re-evaluation, BOOL as bool, default STRING 254 vs 80). S3b merged (PR #62 `f15e128`): wrappers = their value (static_asserts), `STRUCPP_MAY_ALIAS` on IECVar/enum/generated STRUCTs + IEC_Ptr scalar deref, `-fno-strict-aliasing` only in builds we drive (not in tests, so tests prove the attribute); C++ diff = 2,450 `struct STRUCPP_MAY_ALIAS X`; arm-none-eabi 13.2 full build OK, avr-g++ 7.3 probe only (no libstdc++). Release F note: RAM per scalar ÷3, SIZEOF PLC sizes, external hosts should add -fno-strict-aliasing. S4 merged (PR #63 `c12696d`): IECString = `char[N+1]`, memchr length, bounded compares, one-member Var wrappers, zero tail on construction, gdb pretty-printer fixed (it had stopped printing strings); runtime-only, C++ identical; MIRROR/LIST_*/FIND_NUM/FLOAT_TO_REAL right through real calls. Release F note: SIZEOF(STRING(80)) 81, embedded $00 ends a string, LEN ~10 ns. Post-S9 list also: a library FUNCTION called with named args is not reordered (`LIST_GET(SEP := 44, …)` fails g++). After S9, separately: 4 pre-existing CMake failures (TimeTest.UnitConversion, DateTest/DtTest.Construction, StringTest.Substring), wire `src/runtime/tests` into npm test/CI, `test_iec_composite.cpp` missing from CMakeLists. Batch 3 left: items 8–19 minus done (see list), plus found in #57: user `TYPE SR` vs library FB `SR`; `TYPE T : STRING(10)` loses length; enum alias emitted as `IECVar<E>`. Found by S9 design: the bundled OSCAT `.stlib` manifest lists FUNCTION VAR locals as required inputs (`library-compiler.ts:690`), so CHR_TO_STRING, MIRROR etc. cannot be called from user code — fix right after S9 (S9's OSCAT e2e needs them callable). OSCAT also WRITES through these pointers (MIRROR, LIST_*), and IECString's separate `length_` must follow the terminator — S9 input.  (my calls by the rules): S3b batch 4 = vendor forms the toolkit sample uses, before R3.2 (`end_semicolon_optional`, empty FOR body, `0` → any POINTER TO as NULL, POINTER TO STRING := ADR(str), in-FB ACTIONs before the body, VAR part in property accessors, GVL.x in FB init args); S4 = LTIME first, STRING[n]/WSTRING[n] in every profile; new S10 = `platform_types` + `bit_type` under twincat3; HRESULT/OTCID stay vendor-library types. Release E is cut after batch 3 item 7 (note owed in the doc); release F = S9 alone. S9 plan: IECVar<T> becomes the raw value, forcing moves to a table applied at cycle start/end; design check of forcing users (debugger, tests, timing) first. Queued at the end of batch 3 (my calls, by the rules): enum value used as INT refused like the variable form (15); VAR initialisers validated against the enum (16); `ARRAY[E2#A..E2#B]` by the standard (17); `:= E2.B` type default parses (18); REF() of ARRAY OF enum element (12); `REF_TO STRING(10)` length (13); cross-length STRING mixes (14). Remote `bugfix/*` branches are not auto-deleted after merge (left; deleting them is outward-facing). Batch 3 list (those three, E2#B lexing, POINTER TO ARRAY OF BYTE over ADR(dword), alias-of-derived STRUCT, SINT#200, uninitialised alias PROGRAM vars, alias vars not IECVar-wrapped, library global `speed`, DIALECTS Checks list). Release E note not yet posted. Was next: ADR into POINTER TO
  STRUCT, UNION one-member initial values. Found: LT#/LTIME# literals absent (S4); `SINT#200` unchecked; an enum member named like a FUNCTION/METHOD hijacks
  its return assignment in C++ (passes analysis, fails g++); alias-of-base := alias-of-derived STRUCT is accepted
  (the EXTENDS check is skipped when both sides are alias names); `REF(s)` into REF_TO STRUCT passes analysis, fails
  g++ (runtime wraps targets in IECVar); an FB call through a pointer `pf^(v := 4)` is a parse error. Found: the lexer refuses `INT#-123`/`LREAL#-0.9` (Ed. 3 Table 5 allows
  it) — added to S3a.
  **Decided 2026-11-09 (user, by card):** `itf = 0`/`<> 0` stay always on; only `itf := 0` needs `interface_zero`.
  PROGRAM methods: one instance per PROGRAM — a PROGRAM is written once and called, never declared/instantiated like
  an FB, so `PRG_A.M()` reaches that single instance from anywhere. Order: typed TRUNC, `trunc_dint`,
  `interface_zero` first (~3 d), then PROGRAM methods, then FB VAR_IN_OUT by reference last. The vendored profile now extends `iec-3`.
  The IEC Ed. 3 copy the user supplied is licensed to another party: cite clause numbers only, never its text. **R4 DONE 2026-11-09** — `src/objectsTreeModel.js` (VS Code-free node graph; ids and contextValue set
  in one place, `getParent` = `node.parent`), thin `treeDataProvider.js`, `groupRootsByProject` moved out of
  `projectMap.js`; `test_objects_tree_ids.js` pins 396 ids / 301 reveal chains (a required gate); suite 84/84 FULL.
  Intended fix: grouped-mode reveal chains now show the tree's own project label (86 mismatches gone). **MERGED** — PR #30 squash `d97cec3`
  into `dev` 2026-11-09 after the dev-host gate passed on Windows; the session branch was restarted from `dev`. and R3.2 full scope (7 d). Next roadmap item: R4.
- **R2 phase 1 BUILT 2026-11-09** on `claude/focused-ptolemy-m6acaz` (pushed; no PR yet — squash-merge rule above
  applies). What exists: Activity Bar container `twincat` (`media/twincat-activitybar.svg`) holding `twincatStart` →
  `twincatExplorer` → `twincatLibraries` (ids unchanged, moved out of `explorer`); start page
  (`src/startPage.js`, `src/startPageHtml.js`, `media/startPage.{js,css}`, shared name rule `media/projectName.js`);
  commands `twincat.openStartPage/createProject/openProject/generateSt/openSettings/openGettingStarted/openRoadmap/
  openReleaseNotes/reportIssue` (`src/commands/startCommands.js`; `generateSt` is NEW — Generate ST was webview-only);
  recents in globalState `twincat.recentSolutions` (`src/recentProjects.js`). Create = `src/projectTemplate.js`
  over `resources/templates/tc3.1.40{24,26}/`, GENERATED by `scripts/build-project-templates.js` (`--check` runs in
  `test_project_template.js`); GUID inventory + derivation calls (approved by the planner 2026-11-09) in DEVELOPMENT.md
  "Project templates". Defect found+fixed: `solutionMap.js` skipped `.tspproj` (a 4024 solution never grouped).
  New harnesses: `test_project_template`, `test_template_diagnostics` (created projects: 0 diagnostics),
  `test_start_contributions`, `test_start_commands`, `test_recent_projects`, `test/browser/run_start_page.js`, and a
  start-page phase in `test/devhost/` (NOT run — Windows only).
  **Remaining:** (1) user, Windows: create one project per version through the command, prove it opens and builds in
  XAE 3.1.4024 / 3.1.4026 — the `.xtv` `TmcHash` is kept stale on purpose (XAE recomputes it) and is the first thing
  to suspect if 4026 complains; (2) `node test/devhost/run.js`; (3) eyeball sidebar, welcome buttons and the start
  page in light + dark themes; (4) phase 2 (XAE automation, decision 1) — not started, TODO in ROADMAP.md R2.
- **Licence switched to AGPL-3.0-or-later** (user's call 2026-11-09): `LICENSE` is the verbatim gnu.org text
  (sha256 `0d96a4ff…abcb0`), `package.json` `license`, README "License" (≤ 0.10.1 stay MIT). Monaco keeps its MIT
  notice (`media/monaco-editor/LICENSE.txt`, THIRD-PARTY-NOTICES.md). Takes effect with the next release (R11).
  Optional, not done: SPDX headers per source file.
- **R11 Marketplace publishing** added after R2 (user's ask 2026-11-09). The user CREATED accounts on the VS Code
  Marketplace and Open VSX 2026-11-09; publisher ID confirmed as `a-abushaqra` (= `package.json`); per release the user either uploads the VSIX or adds `VSCE_PAT`/`OVSX_PAT` secrets; our part is
  ~1 h of metadata/CHANGELOG/README disclaimer + a secret-gated publish step in `release.yml`.
- **Compiler name in the UI (user ruling 2026-11-09):** the extension's UI and user-facing README name no compiler
  ("Compile project", not "Check with STruC++"); `test_start_contributions.js` pins that the start page never says
  STruC++. Developer docs, ROADMAP.md and the published roadmap page may keep the name.
- **Backlog scheduled 2026-11-09 (user's ask):** toolkit R6–R10 (R10 on trigger only) and fork S3a–S8 are now rows in
  ROADMAP.md with my own sizing (not measured) at the Nov 9 velocity, ~4 h of session per working day. **S3a (three
  false positives on correct code) goes before R3.2**; S7 (iec-3 audit) needs the user's decision first; S8 after R3.3.
- **Roadmap re-measured 2026-11-09** (user's ask): ~20 planned days were delivered in ~7 h that day (ROADMAP.md
  "Velocity"). New forecasts assume half that pace; toolkit R2–R3.3 ~2026-11-17, R6–R9 ~2026-11-19, S2 ~2026-11-11, fork S3a–S8 ~2026-11-18. The real pacing
  item is the user's Windows checks (R5 XAE, R4 dev-host via PR #30, R2 skeleton/XAE proofs) — never forecast.
- **Was next: R3.1** (STruC++ spike) — [ROADMAP.md](ROADMAP.md) (page https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv,
  source `docs/roadmap.html`). Order: R3.1 → R4 Objects-tree model (deepening P7) → R2 create a TwinCAT project →
  R3.2 check command → R3.3 packaging. Forecast end 2026-12-05. Every R2/R3 decision is SETTLED (2026-11-09,
  recorded under each item in ROADMAP.md) — do not re-ask them. When an item starts, moves or merges, update
  ROADMAP.md AND `docs/roadmap.html` and republish the page to the same URL (rule in CLAUDE.md).
- **R3 inputs:** STruC++ fork `AbuShaqra/STruCpp`, default branch `development` (@ `2c223c9`, v0.7.0, GPL-3.0-only,
  Node ≥ 22; dialect flags `--dialect-file`/`--dialect-path`, `src/dialect.ts`, `docs/DIALECTS.md`;
  `npm run build:bundle` → `dist/strucpp-bundle.cjs`). The TwinCAT profile is vendored at
  `resources/dialects/twincat3.json` — that file is the only external input. **Do not name, link or describe where
  it came from** in any file, commit or comment (user rule 2026-11-09: the source is a private repository the user
  has disconnected). The STruCpp repo has its own CLAUDE.md process rules — read them before changing it.
- **Cloud-session traps (2026-11-09):** the git proxy accepts pushes ONLY to the session branch (deleting other
  branches failed every time); `git reset --hard` was refused by the auto-mode classifier — use revert + merge.

## Open / deferred (each with the reason it waits)
- Deepening roadmap: everything but P7 (now roadmap R4) is shipped or ruled (P9 no-go; rulings in the findings file).
- **Manual residue on the user's machine:** Libraries-view scoping (TreeView description rendering, webview tab
  switches, startup seeding, `.plcproj`-watcher path end-to-end); library member expansion has never been visually
  confirmed; squiggle rendering is eyeballed only; peek dismissal over the real bridge round-trip.
- **Showcase screenshots** (`scratch/showcase/{run.js,runner.js,shot.ps1}`) exist only on the user's machine
  (`scratch/` is git-ignored) — move to `scripts/showcase/` (+ `.vscodeignore`) if they are worth keeping.
- **Deferred by decision** (indexing cuts, L1 reverse index, rename v1 limits, ESLint 10, small language gaps): the
  ROADMAP.md backlog lists them; each one's reason and numbers are in `docs/handoff-findings.md` "Deferred work".
- **Browser harnesses:** each trips its "browser reported no errors" catch-all on a worker-level 404 that reproduces
  with the old code too — environmental, not yet chased down.

## Do-not-break list (details in the findings file / DEVELOPMENT.md)
- `sample/` is ground truth: every diagnostic on it is a bug; never raise a baseline. Verify library-related
  changes with `_Libraries/Beckhoff Automation GmbH` present AND moved aside (move it, never delete).
- Never teach `custom/reindex` to skip; never add `_libraries` to `SKIP_DIRS`; register library symbols on demand
  only; cached signature records stay private copies (DEVELOPMENT.md "Indexing cost").
- Library types are anonymous UNKNOWN on purpose; member-checking them stays OFF (four guards in `types.js`).
- Normalized (lowercased) path keys are identity, never file paths or uris
  (`.claude/memory/normalized-keys-are-not-file-paths.md`); scope every name-keyed structure per `.plcproj`.
- `.gitattributes eol=crlf` is load-bearing — never delete it. Use `dir/*`, not `dir/`, before gitignore negations.
- TwinCAT's XML loader is order-sensitive: root `<Folder>` tags and new members must land before `<LineIds>`.
- `templates/` ships in the VSIX and must stay generic; `scripts/Build PLC project/` is the fuller, unshipped
  copy. The user syncs the two BY HAND — never promote one into the other automatically.
- Internal ids (`twincat.*`, `twincat.xmlViewer`) are deliberately not renamed.

## Working agreement
Implementation is delegated to the **`implementer`** agent; the main conversation owns architecture/planning/review/
commits. **Verify every agent claim** (several haven't survived checking); agents run in parallel only with strictly
disjoint file ownership, and never run `git stash`/`checkout`/`reset` while another agent has uncommitted work
in the tree (2026-11-09: one stashed to count old-code failures; harmless only because the other's work was
already committed); `package.json`/`HANDOFF.md` stay centrally owned. **Verify your own claims too** — three
times an unmeasured but plausible assumption was wrong. Measure, then report.
**Hard-won lessons live in `.claude/memory/`** (committed, so they cross machines), injected each session by the
`SessionStart` hook in `.claude/settings.json`. Write new ones THERE, not in the per-machine bank — rules in
CLAUDE.md. Note `autoMemoryDirectory` cannot do this job: it is **ignored from a checked-in settings.json** by
design, which is why this is a hook.
