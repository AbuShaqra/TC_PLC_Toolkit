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

## Batch 3 — accepted, then g++ fails

Library calls:
- [ ] A library FUNCTION output bound positionally (`F_One(x, lw1)`).
- [ ] A library FUNCTION call leaving an inline-array output unbound (`IEC___INLINE_ARRAY_INT` not declared).
- [ ] `ARRAY OF POINTER` output bound to LWORD (no diagnostic).
- [ ] Unmarked archive: a pointer output into LWORD gives a false "Cannot assign INT to ULINT" or fails g++.
- [ ] `REFERENCE TO STRING(n)` bound to a library STRING in-out; a library METHOD `VAR_IN_OUT ARRAY[*] OF STRING`
      even with equal lengths.

Strings:
- [ ] `MAX(s, 'b')` with a STRING variable and a literal; `p^ = 'b'` with `POINTER TO CHAR`.
- [ ] `LEFT(s, ADR(x))` / `INSERT(…, ADR(x))` (no diagnostic; `iec-std-functions.stlib` has no shapes).
- [ ] Typed literals `STRING#'abc'` / `WSTRING#"abc"` do not parse.

REAL MOD and other forms:
- [ ] REAL MOD is still accepted through a pointer declared with a named type (`TYPE PR : POINTER TO REAL`), a
      dereference inside a larger operand (`(p^ + 1.0) MOD 2`), a METHOD/PROPERTY REAL result, and STRUCT
      defaults / VAR_GLOBAL CONSTANT folding. **Decided (user, 2026-11-24): `MOD(a, b)` on REAL/LREAL is
      refused like the operator, in every mode.**
- [ ] `__DELETE(p)` with `p : REF_TO INT` passes `--check`.
- [ ] STRUCT field initial values get no standard-function argument-count check (`LIMIT(1,2)`).
- [ ] Test files: `UPPER_BOUND(a, r)` with `r` a REAL (truncated) or STRING (g++ fails); `ABS(EN := TRUE,
      IN := -3)` keeps EN in the C++; `((p1)) = (p2)` of two STRUCTs.

## Batch 4 — missing diagnostics, wrong refusals, tooling

Type checks:
- [ ] Library FUNCTION arguments are not type-checked unless the function has a REFERENCE TO input
      (`CHECK_PARITY(w, 'abc')` passes).
- [ ] BOOL-input warning missing for interface calls (`it.M(i)`), `SUPER.M(q := i)`, `p^(b := i)`, `s.f(b := i)`,
      `arr[0](b := i)`, TIME/DATE arguments (silent while `x := t` is an error), `EN := i` on a library FB;
      BOOL aliases are inconsistent (`FA(i)` with a `TB : BOOL` alias warns, `tb := i` is silent, `--strict` silent on both).
- [ ] `DATE * n`, unary minus on DATE/TOD/DT and `LTIME * LTIME` are accepted.
- [ ] `UPPER_BOUND` with one argument, of a literal or of a POINTER global compiles in default mode; a named
      constant DIM below 1 (`VAR CONSTANT KZ := 0`) is not refused.

ADR, REF and pointers:
- [ ] ADR into an ARRAY or STRUCT value input; a narrow alias defined in a library (`TYPE TDw2 : DWORD`);
      a namespace-qualified library call (`lib.F_R`) skips the REF_TO check; `REF` of an INT member of a library
      STRUCT into `REF_TO DINT` (a project FUNCTION refuses it); library FB `REF_TO STRING` inputs may hit the
      same false refusal as N1.
- [ ] Misaligned global/test-file pointer initial values; an integer or pointer difference stored into a
      POINTER TO; no misalignment check for POINTER TO ARRAY/STRUCT targets; POINTER TO BYTE arithmetic warns INT→BYTE.

Global initial values (iec-3 / `--strict`):
- [ ] `ADR(p^)` / `ADR(pa^[1])` read `p` but are accepted; a method call on a non-CONSTANT FB global
      (`x : INT := f.M()`) is accepted; an index inside `ADR()`/`REF()` (`ADR(arr[g])`) is not checked.
- [ ] `UPPER_BOUND(DIM := d, ARR := arr)` (named, reverse order) is refused; other standard functions with
      reordered named arguments in a global initial value too.
- [ ] Redundant "no CONSTANT" error on a duplicate RESOURCE global.
- [ ] **Your call:** should `UPPER_BOUND`/`LOWER_BOUND` of a fixed array be allowed in a global initial value
      under `--strict`/iec-3? (Refused today.)

Wrong refusals:
- [ ] `VAR_EXTERNAL CONSTANT` without an initializer is refused in every mode.
- [ ] `VAR x : TIME := LTIME#3ms` is refused while the same assignment in a body is accepted.
- [ ] Decide: `VAR_GLOBAL v : ARRAY[*] OF INT` compiles with no error.

Warnings:
- [ ] Too-long string literal warning (B10) not given for METHOD calls, FB via array element/STRUCT member, FB
      instance initialisers, assignments to a field/element/dereference, PROPERTY bodies.
- [ ] iec-3 FOR-variable warning misses writes through pointer/reference/VAR_IN_OUT and output captures
      (`f(q => i)`), and names the variable upper-cased.
- [ ] iec-3 TRUNC warning fires for an FB inheriting TRUNC from a library base FB, and for an FB instance named
      TRUNC (`TRUNC(a := 1.5)` is an FB call).
- [ ] iec-3 C5 (reserved names): test-file messages use upper-cased names with no locator; IL labels/JMP targets
      are not checked; the locator takes the first match.
- [ ] S7: `E.M` in an array/STRUCT literal used as a TYPE default is refused only when a variable uses the type;
      `E.M` refusals are in pass 3, so a type error hides them; UNION `=` is reported as "two STRUCT values";
      a test file's `((p1)) = p2` of two STRUCTs is not refused under iec-3.
- [ ] `--compile-lib` and `--test` print no source warnings (FB_init/FB_exit warnings missing there).
- [ ] Diagnostics after an IL POU are shifted by the IL→ST line changes.
- [ ] `analyzeTestFile()` without a dialect argument uses the default feature set.

Tooling and tests:
- [ ] Tests leave `/tmp/strucpp-*` directories behind (about 6200, 9.3 GB, once filled the disk); `strucpp --test`
      leaves `/tmp/strucpp-test-*` when a test fails. Remove temp dirs in `afterAll`.
- [ ] `cpp-compile` `with_lock` test failed once under load and passed on rerun (possible flake).
- [ ] Language server: a pointer used as a FOR control variable is not flagged.

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
