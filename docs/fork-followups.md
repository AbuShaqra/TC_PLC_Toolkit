# Fork follow-ups after release N (S13)

Open findings in the STruC++ fork (`AbuShaqra/STruCpp`, branch `development`) that the toolkit bundles. They
were collected in the S6 and S7 review rounds (2026-11-13 to 2026-11-15) and are scheduled as roadmap item
**S13**. None is a regression from release M: each behaved the same (or failed to build) before. The two
high findings of those rounds (EN/ENO on a call inside an expression; `UPPER_BOUND()` with no arguments
crashing the compiler) were fixed before release N and are not listed.

**Kinds:** *wrong result* = builds and runs, computes the wrong value. *g++ fails* = the check accepts the
program, the generated C++ does not compile (nothing wrong runs, but the error comes late and is confusing).
*no diagnostic* = wrong code passes the check. *refused* = correct code is rejected.

Last checked against the fork: 2026-11-15 (release N, `d9b7c01`); batches 5–6 on 2026-11-23 (`e179e2c`). Re-check each item before fixing it.

## S16 — S15's follow-ups (collected 2026-11-25, not scheduled in detail)

Found while implementing and reviewing S15 and not fixed in the batch that found them. Items S15's later batches
fixed are left out; items its open PRs (#218, #219, F, G) leave behind are added when those merge. Same rules as S15.

**User decision (2026-11-25):** a variable named like a plain (non-interface) method of its own FB is **accepted and
renamed in the generated C++**, as interface methods already are (refused today).

**Pass the check, then fail g++**
- a VAR_EXTERNAL named like a method fails when read (the method hides the global);
- a variable named like an inherited method compiles, but calling that method on the derived instance fails;
- a property of a VAR_GLOBAL CONSTANT FB emits `GCH.PI` (also before S15);
- `SUPER^(IN := IN, PT := PT)` inside an FB extending a library FB emits `TON::operator()(IN, PT)`;
- initializer elements are not type-checked in general: `(t := 'abc')` into a TIME (only LTIME was handled);
- inline `VAR_IN_OUT REFERENCE TO ARRAY[..]` (could follow #215's alias form);
- on both trees: `(r) = (q)` on a REF_TO STRUCT, `a[ADR(x)]`, two `ARRAY[*]` input forms;
- untested: an FB with a STRUCT `REFERENCE TO` in-out given a different STRUCT.
- a CONFIGURATION global whose initial value reads a list global holding an FB: named directly (`x := f.M()`) it fails g++ (configuration storage is emitted before the late globals); through code it would read the FB before it exists (found in #221);
- `p := THIS` into a POINTER TO the FB passes the check and fails g++;
- `s.NF(2)` on an inherited STRUCT member is not refused (a local STRUCT is) and fails g++;
- reading a property by its bare name inside its own or a derived FB (`q := pp.x`): "'PP' was not declared" (also before S15);

**Accepted silently, or values that may be wrong**
- a CONSTANT FB's interface-typed property getter can change the instance (`ch.PI.Bump()`, via the `const_cast` helper);
- `r1 := ps^.p` (pointer into INT) has no diagnostic;
- writes through a POINTER TO / REFERENCE TO an interface variable do not reach it (`pgi^ := fx` leaves `gi` NULL; found reviewing #221, also before S15);
- a global initial value calling a method that relies on FB_init runs before FB_init and faults (found reviewing #221);
- global initial values (#221): a NULL ARRAY OF interface global still reaches every implementer; `pp^ := ADR(g)` and a REFERENCE TO member reached through a field still widen to every address taken; an unbound FUNCTION `VAR_OUTPUT ARRAY[*]` faults with a message naming VAR_IN_OUT;
- `e := E_Mode#IDLEX` (an undefined enum value) has no error (found reviewing #220; recheck after #219, which adds unknown-input checks for library blocks);
- ARRAY OF INT into ARRAY OF a subrange stores out-of-range values silently (a scalar store faults);
- an ARRAY of a subrange without its own default starts at 0, a scalar of it at its lower bound; 4-D arrays get no element default;
- defaults not applied (already before #219): elements of an ARRAY of an array TYPE with a default, nested partial initializers `[[1],[2,3]]`, ARRAY-alias types; a library alias default that is a function call is dropped; a library `TYPE ATT : TIME := KTC` (an LTIME constant) is not wrapped, so the consumer gets an unfixable warning;
- `TYPE LB : LTIME := (LTIME#1s + LTIME#500ms) * 2` gives -1294967296 (`iec_mul<DINT_t>`);
- `STRING(n)` variables are not in the debug table anywhere (program locals, CONFIGURATION and GVL globals: "not debuggable: declared STRING(10)"); the per-leaf width is missing in the dispatch;
- `b := 300` into BYTE/WORD: the literal-fit warning covers integer targets only;
- `si := SEL(x, si, 300)` gives 44 with no warning (SEL is typed now, so the constant can be checked);
- `(d ** 2) MOD 3` into an LREAL keeps `iec_mod` on a double;
- a library FB with an inherited `ARRAY[*] OF STRING` in-out: only the FB's own manifest fields are read;
- a constant `0 ** -1` (like `5 / 0`) has no compile-time diagnostic; it faults at run time, at start-up in a `VAR CONSTANT` initializer;
- `5 - dt` is refused while `5 - ldt` only warns in default mode.
- in a test assertion, `NOT` of a promoted BYTE/WORD expression (`ASSERT_EQ(NOT (b AND 16#0F), 255)`) complements at int width (stored into a BYTE first it is right);
- signed SHL/SHR stay a default-mode vendor extension with no warning (SHR arithmetic); only ROL/ROR warn;
- AND/OR/XOR of a signed integer with a bit string in a global/CONFIGURATION initial value is not typed by the rule.

**Missing checks and inconsistencies**
- `w ** 2` on a WORD is accepted while `EXPT(w, 2)` is refused; EXPT's IN2 is registered ANY_REAL (the standard: ANY_NUM);
- a plain `p^` (no alias) is untyped in the checker; typing it needs its own corpus pass;
- a TYPE alias of `REFERENCE TO ARRAY[..]` is not parsed;
- an alias in-out bound to its own base type warns "passed by copy-in / copy-out";
- `ADR(FP()^)` is refused (cleanly);
- `ADVANCE_TIME(E#a)` beside a test variable `e` resolves to the variable and is not checked.
- LTIME into TIME through a FUNCTION/METHOD output capture, a member FB call (`a.b.inst(o => v)`) or an FB_init argument is still an error (an FB output capture warns and converts since #219);
- an enum default written as a typed literal (`:= E#B`) may be missed by `enumDefaultName` (pending #219's recheck).

**Not supported yet (refused cleanly)**
- ADD/SUB/DIV of two date/time values through the functions (rest of Table 35);
- the `NS.E#Member` literal form (`NS.E.Member` works);
- a test variable hiding a list global (`GVL.x` with a test VAR `x`);
- a test-file program instance with an initial value (`p : PExt := (...)`) is not wired to CONFIGURATION globals.

**Housekeeping**
- code and messages cite "Table 30" for date/time arithmetic; in Ed. 3 that is Table 35;
- no CLI test for `--lib-st-namespace`;
- the coverage gate (`test:coverage`) not run on the S15 branches; the suite's 7 skipped tests not identified;
- the vscode-extension server calls `analyzeTestFile` without the source AST or the strict flag;
- `cli-union.test.ts` failed once under load ("Unexpected end of JSON input").

## S15 — S13's follow-ups (planned 2026-11-25)

The open "Found in / Found reviewing" entries below, regrouped into seven batches. Every item is first reproduced on
`development` (`54a617d`); one that no longer reproduces is pinned with a test. Same rules as S13: one PR per batch
(split if large), review, fixes, one recheck; errors in default mode only where the code is invalid AND failed g++ or
ran wrong, otherwise a warning by default and an error under iec-3/`--strict`.

**User decisions (2026-11-25):**
- an untyped literal that does not fit its target (`s := 200` into a SINT) **warns by default**; `--strict`/iec-3 keep
  today's warning (the card said "as today"); hex/binary/octal literals whose bit pattern fits the width
  (`16#FFFF` into INT) keep development's behaviour;
- LTIME into TIME in STRUCT/array initializer fields and FUNCTION/FB inputs **warns by default, error under
  `--strict`/iec-3** (a body and a VAR initial value stay as they are);
- **namespace-qualified library calls** (`plib.F_R(...)`) are supported as a dialect feature, on in `twincat3`, off by
  default and under iec-3;
- an inline **`REFERENCE TO ARRAY[..] OF T`** (and `REFERENCE TO POINTER TO T` if TwinCAT accepts it) is supported
  wherever an alias works.

**Batches, in order:**
- **A — silent wrong values** (done 2026-11-25, fork #215; `**` is real in real contexts, IEC Table 71 note b / Table 29 note f): enum with explicit values defaults to 0; outputs copied with EN = FALSE; non-atomic bit
  store to a VAR_EXTERNAL under threads; constant `**` above DINT divides as integers; `d ** 20 * 4 + 1` wraps at DINT;
  `TIME_TO_DATE` / `LTIME_TO_DATE` units; a library METHOD call inside arithmetic evaluated out of order;
  `ARRAY[*] OF STRING` in-out loses the callee's write; a 254-character output not written into STRING(80); an output
  capture into a property does not call the setter; `VAR_IN_OUT REFERENCE TO T` aborts; `ps^ + 'x'` concatenates;
  `si + 3` typed INT; the `s := 200` warning (decision).
- **B — pointers, references and aliases that pass the check and fail g++** (done 2026-11-25, fork #217; integers into a REF_TO are errors, 0/NULL builds as NULL): the #206/#208/#209/#210/#213 pointer
  items (POINTER TO aliases with ADR/MOD/`__NEW`/REF=, REFERENCE TO alias bindings, `POINTER TO POINTER` input,
  STRUCT pointer members from ADR of another type or a pointer variable, `lw = ADR(x)`, `LWORD_TO_DWORD(ADR(x))`,
  POINTER TO ARRAY as an integer input, ADR into a REF_TO input, `p := 5`, `ul := p`, `ps^ = 1`, `ps > 0`, `p^ := 65`,
  MEMCPY of pointers, pointer FOR loops g++ refuses) and inline `REFERENCE TO ARRAY` (decision).
- **C — OOP, interfaces, properties and call results** (done 2026-11-25, fork #216; also the 39 OSCAT library-STRUCT results from E): the batch-6 OOP items, the #199 and #201 items, call results
  (`FP()^.x`, `F().M();`, selectors after `THIS^.M()`), argument types in member-chain method calls, `j.PJ.M()`,
  `h.P^`, `s.f.M()` with a library STRUCT and FB, a parameter named like its STRUCT type, user alias in-outs of an
  interface METHOD.
- **D — standard functions, strings and test files** (done 2026-11-25, fork #218; integer NOT is now the bitwise complement, signed ROL/ROR rotate as the bit string with a warning, signed-with-bit-string takes the wider type / the bit string at equal width): functional AND/OR/XOR on signed integers with a literal,
  `EXPT(w + 1, 2)`, nested generics (`static_cast<IEC_ANY>`), MUX with an enum selector, `LDATE_TO_LINT`, STRING(10)
  into a STRING VAR_EXTERNAL, `1 + ldt`, `DIV(ltime, n)`, integer `**` with negative exponents and into bit strings,
  `**` in STRUCT defaults, `UDINT := 2 ** 3` under `--strict`, a bare FUNCTION call in a global initial value, and the
  test-file items (`ADVANCE_TIME` type, `GVL.x`, `MOD(a + 1, 5)`, `ASSERT_EQ` on WSTRING/CHAR, a PROGRAM with
  VAR_EXTERNAL, a FUNCTION writing a CONFIGURATION global).
- **E — libraries and missing checks:** a library STRUCT FUNCTION result into the same STRUCT (39 OSCAT calls), a
  library STRUCT-alias result, library enum literals, `DAY_OF_WEEK(IN := …)`, unknown named FB inputs
  (`CTU(RESET := …)`), argument checks on conversions and std functions (`DT_TO_TOD(vd)`), alias-typed argument values,
  scalar library in/outs under `--strict`, wrong-size arrays and `ARRAY OF DINT` into `ARRAY OF INT`, `--strict` BYTE
  arithmetic through a dereference, Table 31 in STRUCT defaults, LTIME→TIME in fields and inputs (decision), the
  `#207` library STRING/array items, a FB EXTENDS TON with an LTIME PT, namespace-qualified library calls (decision).
- **F — debug table, diagnostics and tooling:** debug-table gaps (incomplete entries, opaque library STRUCT arrays and
  enum/array aliases, inherited library FB members, skipped warnings per instance), an IL↔ST line map for diagnostics
  inside IL, names upper-cased in messages, TEST name escapes, literal underscores in test files and their cost,
  `1_000.5`, the packaging item, and `analyze()`'s extra compile for the race warning.
- **G — global initial values:** CONFIGURATION globals traced, a NULL interface global refused as a self-read, the
  coarse pointer analysis made finer, FUNCTION `VAR_OUTPUT ARRAY[*]`.

## Batch 1 — wrong results (done 2026-11-24, fork #202–#205)

Arithmetic and types:
- [x] (fork #204, 2026-11-24) DINT/LINT overflow is C++ undefined behaviour in: unary minus of the minimum, `ADD`/`SUB`/`MUL`/`ABS`
      called as functions (`iec_std_lib.hpp` ~1480–1510), `ABS(min)`, INT variable + LINT literal, untyped
      `2147483647 + 1` into a DINT initial value or STRUCT default, `LINT#2 ** 63`.
- [x] (fork #203, 2026-11-24) Narrow (INT/SINT) intermediates whose operand type is not resolved (some `SUPER.x`, globals reached as
      `B.value`, method results) keep the plain operator and wrap at the narrow width (compute-wide is partial).
- [x] (fork #203, 2026-11-24) Mixed-sign AND/OR/XOR uses C++ promotion in VAR_GLOBAL initial values (also CONFIGURATION/RESOURCE)
      and STRUCT-instance overrides (`x : St := (f := …)`): `DINT#-7 OR UDINT#4000000000` gives 4294967289.
- [x] (fork #203, 2026-11-24) `DWORD/86400 + 3` is typed INT (mixed DWORD/untyped arithmetic too narrow); a POINTER operand of `+`/`-`
      is typed as its target.
- [x] (fork #204, 2026-11-24) `LINT := 2147483647 + 1` is folded in 32 bits; `UDINT := 4294967295 + 1` is refused as INT.
- [x] (fork #204, 2026-11-24) `LTIME / LTIME` emits plain C++ `/`: division by LTIME 0 is undefined behaviour.

Dates and times (32-bit):
- [x] (fork #205, 2026-11-24: every route agrees; integer→DATE floors negative inputs; L types keep pre-1970) Dates before 1970 wrap; the same day gives different DATE values by route (`CONCAT_DATE(1969,12,31)` vs
      `D#1970-01-01 - T#1d` / `STRING_TO_DATE`). Restore the pre-1970 test coverage removed with the 32-bit change.
- [x] (fork #205, 2026-11-24: warning by default, error under iec-3/--strict) Digits below the unit in DT/TOD literals are dropped silently.

Strings and arrays:
- [x] (fork #202, 2026-11-24: warning added, C++ literal cut; values were already consistent) A literal with an embedded `$00` is cut at the NUL (`'a' = 'a$00b'` is TRUE).
- [x] (fork #202, 2026-11-24) `UPPER_BOUND(a1, 2)` on a 1-D array returns dimension 1 (`iec_array.hpp:161-162` ignores the argument);
      a 2-D array with DIM other than 1/2 at run time returns dimension 2's bounds.

Other:
- [x] (fork #202, 2026-11-24; also `M := x` exited the method early and a bare RETURN returned `*this`) A METHOD/FUNCTION returning an interface with no result assigned on a path falls off the end of the C++
      function (UBSan: no return); it should return NULL.
- [x] (fork #202, 2026-11-24; also function outputs and bit stores to a scalar VAR_EXTERNAL were lost) `ENO => gok` with `gok` a scalar VAR_EXTERNAL under a CONFIGURATION emits `GOK->read(…)`.

## Batch 2 — library manifest: lengths and kinds (done 2026-11-24, fork #206–#207)

The archive manifest loses information, which causes several findings in the other batches:
- [x] (fork #206, 2026-11-24) STRING(n) lengths are not recorded for library FB inputs and STRUCT fields (`STRING(n)`/`STRING(254)` become
      bare STRING, so an 80-character profile reads them as 80), library globals, PROPERTY types, FB members (the
      debug table shows 254), `ARRAY[*] OF STRING` parameters (read as 254 in a consumer), and `POINTER TO` /
      `REF_TO STRING(n)` parameters (a `POINTER TO STRING(20)` output into LWORD fails g++).
- [x] (fork #206, 2026-11-24) `REFERENCE TO ARRAY` and `REFERENCE TO POINTER` parameters are recorded by bare type name.
- [x] (fork #206, 2026-11-24) Archives built before release N keep refusing ADR into pointer inputs until rebuilt.
- [x] (fork #207, 2026-11-24) string-80 debug table: arrays of STRUCT with string fields warn once per element per field; the "not
      debuggable" advice tells the user to redeclare a library variable.
- [x] (fork #207, 2026-11-24) string-80: the `isPlainString` copy also applies to user POU STRING parameters with the feature off
      (helps, but untested and undocumented).

## Batch 3 — accepted, then g++ fails (done 2026-11-24, fork #208–#210)

Library calls:
- [x] (fork #210, 2026-11-24) A library FUNCTION output bound positionally (`F_One(x, lw1)`).
- [x] (fork #210, 2026-11-24) A library FUNCTION call leaving an inline-array output unbound (`IEC___INLINE_ARRAY_INT` not declared).
- [x] (fork #210, 2026-11-24) `ARRAY OF POINTER` output bound to LWORD (no diagnostic).
- [x] (fork #210, 2026-11-24) Unmarked archive: a pointer output into LWORD gives a false "Cannot assign INT to ULINT" or fails g++.
- [x] (fork #210, 2026-11-24) `REFERENCE TO STRING(n)` bound to a library STRING in-out; a library METHOD `VAR_IN_OUT ARRAY[*] OF STRING`
      even with equal lengths.

Strings:
- [x] (fork #209, 2026-11-24) `MAX(s, 'b')` with a STRING variable and a literal; `p^ = 'b'` with `POINTER TO CHAR`.
- [x] (fork #209, 2026-11-24) `LEFT(s, ADR(x))` / `INSERT(…, ADR(x))` (no diagnostic; `iec-std-functions.stlib` has no shapes).
- [x] (fork #209, 2026-11-24) Typed literals `STRING#'abc'` / `WSTRING#"abc"` do not parse.

REAL MOD and other forms:
- [x] (fork #208, 2026-11-24) REAL MOD is still accepted through a pointer declared with a named type (`TYPE PR : POINTER TO REAL`), a
      dereference inside a larger operand (`(p^ + 1.0) MOD 2`), a METHOD/PROPERTY REAL result, and STRUCT
      defaults / VAR_GLOBAL CONSTANT folding. **Decided (user, 2026-11-24): `MOD(a, b)` on REAL/LREAL is
      refused like the operator, in every mode.**
- [x] (fork #208, 2026-11-24) `__DELETE(p)` with `p : REF_TO INT` passes `--check`.
- [x] (fork #208, 2026-11-24) STRUCT field initial values get no standard-function argument-count check (`LIMIT(1,2)`).
- [x] (fork #208, 2026-11-24) Test files: `UPPER_BOUND(a, r)` with `r` a REAL (truncated) or STRING (g++ fails); `ABS(EN := TRUE,
      IN := -3)` keeps EN in the C++; `((p1)) = (p2)` of two STRUCTs.

## Batch 4 — missing diagnostics, wrong refusals, tooling (done 2026-11-24, fork #211–#213)

Type checks:
- [x] (fork #213, 2026-11-24) Library FUNCTION arguments are not type-checked unless the function has a REFERENCE TO input
      (`CHECK_PARITY(w, 'abc')` passes).
      **Decided (user, 2026-11-24):** argument narrowing on non-BOOL inputs (DINT into an INT input) warns by default
      like assignment, error under `--strict` (measured: 0 new warnings on the corpus, OSCAT and library consumers).
- [x] (fork #213, 2026-11-24) BOOL-input warning missing for interface calls (`it.M(i)`), `SUPER.M(q := i)`, `p^(b := i)`, `s.f(b := i)`,
      `arr[0](b := i)`, TIME/DATE arguments (silent while `x := t` is an error), `EN := i` on a library FB;
      BOOL aliases are inconsistent (`FA(i)` with a `TB : BOOL` alias warns, `tb := i` is silent, `--strict` silent on both).
- [x] (fork #213, 2026-11-24) `DATE * n`, unary minus on DATE/TOD/DT and `LTIME * LTIME` are accepted.
- [x] (fork #213, 2026-11-24) `UPPER_BOUND` with one argument, of a literal or of a POINTER global compiles in default mode; a named
      constant DIM below 1 (`VAR CONSTANT KZ := 0`) is not refused.

ADR, REF and pointers:
- [x] (fork #213, 2026-11-24) ADR into an ARRAY or STRUCT value input; a narrow alias defined in a library (`TYPE TDw2 : DWORD`);
      a namespace-qualified library call (`lib.F_R`) skips the REF_TO check; `REF` of an INT member of a library
      STRUCT into `REF_TO DINT` (a project FUNCTION refuses it); library FB `REF_TO STRING` inputs may hit the
      same false refusal as N1.
- [x] (fork #213, 2026-11-24) Misaligned global/test-file pointer initial values; an integer or pointer difference stored into a
      POINTER TO; no misalignment check for POINTER TO ARRAY/STRUCT targets; POINTER TO BYTE arithmetic warns INT→BYTE.

Global initial values (iec-3 / `--strict`):
- [x] (fork #211, 2026-11-24) `ADR(p^)` / `ADR(pa^[1])` read `p` but are accepted; a method call on a non-CONSTANT FB global
      (`x : INT := f.M()`) is accepted; an index inside `ADR()`/`REF()` (`ADR(arr[g])`) is not checked.
- [x] (fork #211, 2026-11-24) `UPPER_BOUND(DIM := d, ARR := arr)` (named, reverse order) is refused; other standard functions with
      reordered named arguments in a global initial value too.
- [x] (fork #211, 2026-11-24) Redundant "no CONSTANT" error on a duplicate RESOURCE global.
- [x] (fork #213, 2026-11-24) **Decided (user, 2026-11-24):** a POINTER TO/REF_TO assigned to a narrower integer (`n := p` into DWORD/INT)
      gets a warning by default and an error under iec-3/`--strict` (OSCAT `_BUFFER_CLEAR`/`_BUFFER_INIT` warn only).
- [x] (fork #211, 2026-11-24) **Decided (user, 2026-11-24): allow** `UPPER_BOUND`/`LOWER_BOUND` of a FIXED array in a global initial value
      under `--strict`/iec-3 (a compile-time constant); `ARRAY[*]` and a non-constant DIM stay refused.

Wrong refusals:
- [x] (fork #211, 2026-11-24) `VAR_EXTERNAL CONSTANT` without an initializer is refused in every mode.
- [x] (fork #211, 2026-11-24) `VAR x : TIME := LTIME#3ms` is refused while the same assignment in a body is accepted.
- [x] (fork #211, 2026-11-24) **Decided (user, 2026-11-24): refuse in every mode** `VAR_GLOBAL v : ARRAY[*] OF INT` (and VAR/VAR_TEMP/STRUCT
      fields): ARRAY[*] needs a fixed size outside VAR_IN_OUT. Also an FB `VAR_INPUT` ARRAY[*] (user, 2026-11-24),
      though it built and ran: Ed. 3 6.5.3 allows ARRAY[*] only in FUNCTION/METHOD parameters and FB VAR_IN_OUT.

Warnings:
- [x] (fork #212, 2026-11-24) Too-long string literal warning (B10) not given for METHOD calls, FB via array element/STRUCT member, FB
      instance initialisers, assignments to a field/element/dereference, PROPERTY bodies.
- [x] (fork #212, 2026-11-24) iec-3 FOR-variable warning misses writes through pointer/reference/VAR_IN_OUT and output captures
      (`f(q => i)`), and names the variable upper-cased.
- [x] (fork #212, 2026-11-24) iec-3 TRUNC warning fires for an FB inheriting TRUNC from a library base FB, and for an FB instance named
      TRUNC (`TRUNC(a := 1.5)` is an FB call).
- [x] (fork #212, 2026-11-24) iec-3 C5 (reserved names): test-file messages use upper-cased names with no locator; IL labels/JMP targets
      are not checked; the locator takes the first match.
- [x] (fork #212, 2026-11-24) S7: `E.M` in an array/STRUCT literal used as a TYPE default is refused only when a variable uses the type;
      `E.M` refusals are in pass 3, so a type error hides them; UNION `=` is reported as "two STRUCT values";
      a test file's `((p1)) = p2` of two STRUCTs is not refused under iec-3.
- [x] (fork #212, 2026-11-24) `--compile-lib` and `--test` print no source warnings (FB_init/FB_exit warnings missing there).
- [x] (fork #212, 2026-11-24) Diagnostics after an IL POU are shifted by the IL→ST line changes.
- [x] (fork #212, 2026-11-24) `analyzeTestFile()` without a dialect argument uses the default feature set.

Tooling and tests:
- [x] (fork #212, 2026-11-24) Tests leave `/tmp/strucpp-*` directories behind (about 6200, 9.3 GB, once filled the disk); `strucpp --test`
      leaves `/tmp/strucpp-test-*` when a test fails. Remove temp dirs in `afterAll`.
- [x] (fork #212, 2026-11-24) `cpp-compile` `with_lock` test failed once under load and passed on rerun (possible flake).
- [x] (fork #212, 2026-11-24) Language server: a pointer used as a FOR control variable is not flagged.

## Batch 5 — further findings (added 2026-11-23; done 2026-11-23, fork #190–#197)

Reported against releases L and N. Quick ones first:
- [x] **Start-up cost** (fork #190, 2026-11-23; cold check 837 → 571 ms): the test parser (`testParser`, `src/frontend/parser.ts`) is constructed at module load next to
      the main parser, and each construction runs the parser library's self-analysis — most of a cold compile's CPU.
      Build it lazily, on first use under `--test`. Keep the CLI's order (load modules, read the primary input once to
      EOF, then discover libraries and compile). Optionally check whether `skipValidations: true` is safe in production.
- [x] **DT/TOD/DATE minus a typed literal** (fork #191, 2026-11-23) is typed DT/TOD (`d1 - DT#2000-01-01-00:00:00`, `TOD#12:00:01 - TOD#12:00:00`),
      while variable minus variable is TIME. IEC Table 30: the result is TIME in every form.
- [x] **Test mode docs** (fork #192, 2026-11-23): `TEST "name"` (double quotes) is accepted since N, but TESTING.md still says it is refused.
- [x] **Test mode install** (fork #193, 2026-11-23): `iec_test.hpp` is not installed with the runtime headers (only in `src/runtime/test`), so a
      test build from an installed release needs an extra `-I`.
- [x] **Test mode** (fork #195, 2026-11-23; it was a parse error, now works in FOR/WHILE/REPEAT/IF/CASE): `ADVANCE_TIME(...)` inside a FOR loop does not advance time per pass (unrolled scans work). Make it
      work in loops, or refuse it there with a clear message.

Check against the standard first:
- [x] **Underscores in literals** (fork #196, 2026-11-23) (decided 2026-11-23: refuse under iec-3 and `--strict`; vendor profiles unchanged):
      IEC Table 5 allows `_` only between two digits. Accepted today: `T#_1s`, `T#1__000ms`, `T#1_ms`, `T#_s`, `T#1._5s`,
      `1__0`, `10_`, `STRING[1__0]`, `CHAR#16#_41`, `CHAR#6_5_` (integer, real, duration and typed literals, STRING lengths).
- [x] **Long conversion names** (fork #194, 2026-11-23; also fixed ~120 typed `<x>_TO_<long>` names that failed g++): `TO_TIME_OF_DAY`, `TO_LTIME_OF_DAY`, `TO_LDATE_AND_TIME` are undeclared while `TO_TOD`,
      `TO_LTOD` and the long `<type>_TO_<type>` names work. Check the standard's conversion table, then accept the long
      spellings of `TO_<type>` for every date and time type as aliases.
- [x] **Member access on a call result** (fork #197, 2026-11-23: feature `call_result_access`, off by default and under iec-3; whether the bundled vendor profiles turn it on is open): `x := f.M(1).nCode;` (a STRUCT result) is a parse error. Decide by the Ed. 3
      grammar; if refused under iec-3, say "assign the result to a variable first" instead of a bare parse error;
      decide separately whether vendor profiles accept it.

Gaps found while reviewing the four fixes above (not yet scheduled; fold into batch 1 or 2 when reached):
- [x] (fork #205, 2026-11-24) **Date/time arithmetic:** `DT + DT`, `TOD + TOD`, `TIME - DT` and `DT * 2` are accepted; IEC Table 30 allows none
      of them. IEC_COMPLIANCE.md also says `DT * number` gives TIME, which is wrong.
- [ ] **TEST names:** escapes (`$'`, `$"`, `$N`) in a TEST name are not decoded; the extension's
      `vscode-extension/server/src/cursor-context.ts` (~line 162) matches single-quoted names only.
- [ ] **Literal underscores in test files:** a misplaced underscore in a STRING length or ARRAY bound declared in a
      test file is not caught (other test-file literals are); `--strict` does not reach test files at all.
- [ ] **Literal underscore check cost:** under iec-3/`--strict` each source is tokenized a second time (~10% on a
      40k-line file); `parse()` could hand back its tokens.
- [ ] **Untyped reals with underscores** (`1_000.5`) do not lex in any mode, though Ed. 3 allows them.
- [ ] **Test files:** the `ADVANCE_TIME` argument is not type-checked (`ADVANCE_TIME(TRUE)` fails only in g++); a
      list-qualified global (`GVL.x`) is undeclared anywhere in a test file.
- [ ] **Call results, not handled:** `^` after a call (`FP()^.x`), a call-result method call as a statement
      (`F().M();`), selectors after `THIS^.M()`; argument *types* in method calls through a member chain are unchecked
      (`fb.M('str')` into an INT input), for variable and call-result receivers alike.
- [ ] **Interfaces and OOP, found in batch 6:** `itf = fbInstance` passes the check, fails in g++; a method VAR_INST FB used as a
      dotted-call receiver (`cnt.Bump()`) fails in g++; a variable or
      VAR_EXTERNAL named like a method of the same FB (`level` / `METHOD Level`) passes the check, fails in g++; a test
      cannot hold a PROGRAM with VAR_EXTERNAL (no default constructor); a FUNCTION writing a CONFIGURATION global through
      VAR_EXTERNAL fails in g++; skipped-debug-table warnings repeat per instance path (25 for one array of FBs holding
      two interfaces) — group them per declaration.
- [ ] **Found reviewing #199:** a method result through a *scalar* variable (`one.State()`) is untyped, so a wrong
      assignment there is not reported; an inherited method with a VAR_OUTPUT on an interface that EXTENDS another fails
      in g++ (`iy.M(8)`); `TYPE T_P : POINTER TO INT` then `tp := ADR(v)` fails in g++; in a method returning
      `POINTER TO S_R`, `PS := ADR(s)` is refused.
- [ ] **Found reviewing #201:** a bit read on a property (`fb.P.4`) emits `FB.P` and fails in g++; a bit read of a
      VAR_GLOBAL CONSTANT in a STRUCT default (`f1 : BOOL := GC.3`) fails in g++.
- [ ] **Found in batch 1 (#202):** an enum with explicit values (`(E1 := 5, …)`) defaults to 0, not its first value;
      with EN = FALSE an FB call's outputs are still copied to their `=>` targets; a bit store to a scalar VAR_EXTERNAL
      is read-then-write (two locks) under STRUCPP_THREADED, so concurrent bit sets can lose a bit — use `with_lock`;
      a named-constant DIM in UPPER/LOWER_BOUND is checked only at run time; `LDATE_TO_LINT(LDATE#…)` fails in g++;
      a STRING(10) written to a STRING VAR_EXTERNAL fails in g++; `j.PJ.M()` through an interface-typed property fails
      in g++.
- [ ] **Found reviewing #204:** a constant `**` above DINT is folded as an integer, so `lr : LREAL := 2 ** 40 / 3` now
      divides as integers (366503875925) while `2 ** 20 / 3` stays real — make it consistent; in `l : LINT := d ** 20 * 4 + 1`
      the power is wide but `*`/`+` wrap at DINT; under --strict `UDINT := 2 ** 3` is refused while `1 + 1` is accepted;
      `**` into a WORD/DWORD/LWORD target keeps `pow` (inexact/UB); `**` in a STRUCT default inside DINT emits invalid C++;
      integer `**` with a negative constant exponent into an integer still uses `pow`; `DIV(ltime, n)` is unchecked.
- [ ] **Found reviewing #205:** `TIME_TO_DATE(T#2d3s)` treats ms as seconds (172803000) and `LTIME_TO_DATE` gives
      non-day values; `1 + ldt` (number on the left of `+` with an L form) is typed INT; a Table 30 error can hide later
      feature-gate errors (first error phase only).
- [ ] **Found in #203:** functional AND/OR/XOR on a signed integer with a literal fails in g++ (also before #203);
      `EXPT(w + 1, 2)` on a WORD is refused with "expects ANY_REAL"; an untyped constant beside a signed/unsigned
      integer still takes the wider type (`si + 3` is INT); a pointer variable's own expression type is its target type.
- [ ] **Found in #206:** through a type alias, `REFERENCE TO` an ARRAY or POINTER alias fails g++ (`ref_bind` no match;
      ADR into a POINTER alias, also a library `PINT : POINTER TO INT` parameter; `rp^` refused); inline
      `REFERENCE TO ARRAY[..] OF T` does not parse; a library-alias `REFERENCE TO TS REF= s` / `REF_TO TS := REF(s)`
      fails g++ where a local alias is refused cleanly; ADR into a `POINTER TO POINTER` input is accepted and segfaults;
      a parameter named like its STRUCT type gives `MYS_` (g++ fails); a library STRUCT-alias result is not assignable
      to its base STRUCT; library enum literals are unusable from a consumer; `VAR_IN_OUT REFERENCE TO T` aborts at run
      time; inherited library FB members are missing from the debug table silently; a METHOD `ARRAY[*]` in/out fails
      g++; a 254-character output captured into STRING(80) is silently not written; development-built archives keep
      the old failures until rebuilt.
- [ ] **Found in #207:** a library FUNCTION/METHOD with an explicit `STRING(254)` in-out given `STRING(80)` fails g++
      (also before); an old default-mode archive's `STRING(20)` in-out given `STRING(20)` fails g++ (length unknown);
      `ARRAY[*] OF STRING` in-out bound to `ARRAY OF STRING(80)` loses the callee's write; a plain STRING STRUCT member
      passed to a `STRING(254)` in-out still warns and copies; `incomplete` debug entries are not collapsed; library
      STRUCT array fields (`__INLINE_ARRAY_BYTE`) and library enum/array aliases stay opaque to the debug table; FUNCTION
      return types record no STRING(n) length; a user alias in-out of an interface METHOD fails g++.
- [ ] **Found in #208:** `TYPE PI : POINTER TO INT; q := ADR(i)` and `MOD(q^, 5)` / `MOD(pi^, 5)` fail g++; nested generic
      calls (`MAX(SEL(b, i, j), 3)`) emit `static_cast<IEC_ANY>` and fail g++; `__NEW` into a non-pointer, into a STRUCT
      `POINTER TO INT` field, or `__NEW(INT, 4)` into a `POINTER TO ARRAY` alias fail g++; REF= through a REFERENCE TO a
      pointer alias fails g++; test-file integer `MOD(a + 1, 5)` fails g++; `strucpp --test` leaves `strucpp-test-*`
      temp dirs on every run; a feature-gate error is hidden when a MOD error is present.
- [ ] **Found in #209:** a POINTER TO/REF_TO stored by assignment into a narrow integer (`n := p`) truncates the
      address on 64-bit hosts; bundled OSCAT `_BUFFER_CLEAR`/`_BUFFER_INIT` rely on it (`temp := pt`) — **needs a user
      decision**; a POINTER TO ARRAY as an integer input fails g++; through a dereferenced `POINTER TO STRING`,
      `ps^ + b` / `ps^ = 1` are not refused (fail g++) and `ps^ + 'x'` builds as concatenation; `ps > 0` fails g++;
      `p^ := 65` into a dereferenced CHAR is accepted; test-file `ASSERT_EQ` on WSTRING or CHAR fails g++;
      `MEMCPY(q, p, 2)` with POINTER TO INT fails g++; MUX with an enum selector fails g++.
- [ ] **Found in #210:** under `--strict`/iec-3 scalar library in/outs are not checked (array ones are); `p := 5` (non-zero
      integer assigned to a pointer) is accepted, and integer function results/conversions into pointer inputs are not
      refused; a library METHOD call inside arithmetic emits plain C++ `+` (`fb.MA(x) + x[1] * 10` gives 1, not 51);
      `s.f.M(...)` with a library STRUCT and FB fails g++; a library ARRAY TYPE records no shape and a library REF_TO alias
      no target; a library STRUCT FUNCTION result into the same STRUCT is refused (39 OSCAT calls); `DAY_OF_WEEK(IN := …)`
      refused; `lw = ADR(x)` fails g++; `ul := p` refused as INT; `ARRAY OF MyI` into `ARRAY OF INT` in/out fails g++; a
      local scalar WORD in/out bound to UINT warns then fails g++; archives older than #210 keep `ArrayView&` METHOD
      prototypes.
- [ ] **Found in #212:** a diagnostic inside an IL body points at generated ST lines (needs an IL↔ST line map);
      POINTER TO FOR loops g++ refuses (`TO 10`, `BY n`) only warn; `FOR p := ADR(x) TO e` (e : PINT) gets a false
      "PINT is not compatible with INT" warning; the FB_exit warning (and likely other AST-name messages) upper-cases
      names; the FOR-variable warning ignores references taken in another POU and the order of REF/ADR assignments.
- [ ] **Found in #213:** `s := 200` (untyped literal that does not fit) gets no default warning; `q.p := ADR(udi)` and
      `q.p := pd` into a STRUCT pointer member fail g++; a wrong-size array into a fixed-size array input fails g++ and
      `ARRAY OF DINT` into `ARRAY OF INT` builds silently; `--strict` misses BYTE arithmetic through a dereference;
      `lw = ADR(x)`, `LWORD_TO_DWORD(ADR(x))` fail g++; namespace-qualified library calls (`plib.F_R`) unsupported;
      argument values of alias type are not checked; conversions/std functions are not argument-checked
      (`DT_TO_TOD(vd)` fails g++); an unknown named FB input (`CTU(RESET := …)`) is not diagnosed; ADR into a REF_TO
      input fails g++; an FB that EXTENDS TON with an LTIME PT fails g++.
- [ ] **Found in #211:** a bare user FUNCTION call in a global initial value fails g++ (prototypes after globals);
      CONFIGURATION globals' initial values are not traced; the pointer analysis is coarse (one unplaceable pointer store
      makes every dereference during global creation read every address-taken global, which can refuse a valid program);
      an interface global that is NULL at creation is refused as a self-read; FUNCTION `VAR_OUTPUT ARRAY[*]` fails g++
      when bound; LTIME→TIME accepted in STRUCT/array initializer fields and FUNCTION/FB inputs; the Table 31 check
      misses STRUCT field defaults; `h.P^` on a POINTER TO property fails g++; an output capture into a property does
      not call the setter.
- [ ] **Packaging:** a stale `vscode-extension/runtime/test/` folder can end up in a VSIX; the `testParser` export was
      removed by #190 (worth a changelog line).

## Batch 6 — OOP through interfaces (added 2026-11-23; done 2026-11-24, fork #198–#201)

Reproduced on `development` `e179e2c`:
- [x] **Result type through an indexed interface element** (fork #199, 2026-11-23): with `arr : ARRAY[1..1] OF I_S` and `METHOD State : E_St`,
      `e := arr[1].State();` fails with "Cannot assign E_ST to E_ST" (as a CASE selector too); a comparison or a scalar
      interface variable works.
- [x] **Interface-typed variables in a POU's VAR crash** (fork #198, 2026-11-23; also fixed a run-time crash after `gIf := fbInst`): a scalar or `ARRAY OF` interface in a PROGRAM's or
      FUNCTION_BLOCK's VAR crashes `debug-table-gen` ("reading 'definition'") once there is a CONFIGURATION. Compile it
      (Ed. 3 allows it); at least an error, never a crash.
- [x] **Global named like a method** (fork #200, 2026-11-23; also the "'X' was not declared" form on a test's SETUP variable, and a method local over a VAR_EXTERNAL with a renamed C++ name): inside an FB implementing `I_Station.Reset`, reading a located global `Reset`
      fails in g++ ("invalid use of non-static member function RESET"). Qualify the global's C++ name.
- [x] **Chained method call with an unbound VAR_OUTPUT** (fork #199, 2026-11-23): `fb.Me().M(5)` / `FF().Me().M(6)` pass the check, g++ fails
      (`__output_tmp` missing; `methodCallOwnerType` in codegen.ts has no MethodCallExpression receiver case). Taken with
      the first item.
- [x] **NOT over an AND of comparisons** (fork #201, 2026-11-24; also fixed: `NOT (w.3)` and `NOT (w.3 AND …)` were always TRUE — a bit read is now a BOOL, so `SHL(w.3, 2)` is FALSE, not 4): `NOT ((a >= DINT#6) AND (b >= DINT#6))` passes the check and fails in g++
      ("no matching function for call to NOT(int)"); the AND of two comparisons is emitted as an int.

## Planned features (decided, not bugs)

- **Lifecycle methods for dynamic instances** (user, 2026-11-15, after release N): `__NEW` runs FB_init (base
  first) and `__DELETE` runs FB_exit (derived first, members after their holder). FB_exit at program stop for
  static instances stays open: it needs a stop hook in whatever runs the generated program.
- **S12 iec-4** (waits for the Edition 4 text), including C6; **S8** is on hold until iec-4.
