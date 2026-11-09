# S2 — STruC++ fork: close the gaps (plan)

Roadmap item **S2** (fork lane). The merged design: the user's compiler findings document, the R3.1 spike
(`docs/r3.1-strucpp-spike.md`) and the first S2 design, checked against the IEC 61131-3 Ed. 3 text.

## Decisions taken (user, 2026-11-09)

- **Scope: all 13 steps** of §3 (about 22 working days), one PR per step into the fork's `development`.
- **`iec` means Ed. 3 (2013).** Interface PROPERTY is therefore a vendor form, behind feature `property`.
- **Chained comparisons follow the Annex A grammar** (equality binds looser than relational comparison).
- **Standard forms are always on** — fixing a standard construct the fork wrongly refused is a defect fix and
  may widen what `iec` accepts; vendor forms stay behind features, off under `iec` (Q2; default taken, the
  user stated no preference).
- **Interface-typed variables are in the core** (step 5, Q3) and the CLI shape is **`--check --json`** (Q4)
  — defaults taken, no preference stated.
- Still open, decided per step when it starts: Q5, Q6, Q7, Q9, Q10, Q11 (settle feature ids before step 3),
  Q12.

Written 2026-11-09.

## Sources and evidence rules

| Name | What | Measured at |
|---|---|---|
| **doc** | The user's findings doc: the Ed. 3 comparison, defects, iec leaks and the 224-feature table (source: user's findings doc) | the fork at `e8af43c` |
| **spike** | `docs/r3.1-strucpp-spike.md` | the fork at `2c223c9` |
| **S2** | the first S2 design (not kept) | the fork at `a529ea9` |
| **Ed3** | IEC 61131-3:2013 (Ed. 3), the full PDF the user supplied. I read the clauses cited below and the Annex A grammar. | – |
| **re-run** | Repros through `node dist/strucpp-bundle.cjs`, with and without `--dialect iec`, plus `--build` (g++) where stated. (Repro files were scratch, not kept.) | the fork at `a529ea9` |

- **Licence.** The Ed. 3 copy is licensed to another party. This file gives clause, table and Annex A
  production names and my own paraphrase only. No text, table or grammar is reproduced.
- **Ed. 4 (2025).** Only the public sample was read: the TOC and clauses 1–3.65. Clause 3.53 includes
  property prototypes in an interface. Every other Ed. 4 statement here is "not enough information".
- **What changed in the fork since the doc was measured.** `e8af43c..a529ea9` adds only the language
  server's dialect support and two docs commits. Every row below that drives a decision was re-run anyway.

## 1. Merged table

Legend:
- **Status**:
  - IEC = in Ed. 3;
  - Ext = not in Ed. 3 (a vendor extension);
  - Variant = an Ed. 3 construct in a vendor spelling or order;
  - n.e.i. = not enough information.
- **At a529ea9**: R = re-run here, S = from the spike or S2 repros at `a529ea9`, D = the doc's result (not
  re-run).
- **Handling**: always-on; or feature `<id>` (new, off under `iec`, not in `DEFAULT_FEATURES`); or defect.
- **Effort**: working days, including unit tests and a g++ end-to-end where code is generated.

### 1a. What the sample project needs (the R3.2 check path)

| # | Construct | Status: Ed3 clause, my paraphrase | At a529ea9 | Handling | Effort | Sources |
|---|---|---|---|---|---|---|
| A1 | Pragma `{attribute …}` (any `{…}` other than `{external}`) | **IEC**. 6.2 and Table 4: braces delimit a pragma, it may appear wherever a space may, but not inside a string literal, and its syntax and meaning are implementer-specific. The Annex A lexer rule treats it as hidden text. | Lexer error at `0:0`, and the file is dropped (S) | Always-on: an unknown pragma becomes trivia with a "pragma ignored" warning. Conditional-compilation pragmas are an error. | 1 | Ed3, doc, spike, S2 |
| A2 | METHOD or PROPERTY written after the POU body | n/a (layout) | Parse error (spike) | **Converter only** (R3.2) | – | spike |
| A3 | Method call through a member chain: `GVL_X.fb.M()`, `h.f.M()` | **IEC for a chain of instance names**: the Annex A `Invocation` production allows one or more FB- or class-instance-name prefixes, optionally after `THIS.`, before the method name. A struct field holding an FB is not named in that production (n.e.i. whether it counts). The GVL-qualified form depends on A7. | `Expected Assign, found (` (S) | Always-on for instance chains and struct fields; the GVL prefix comes with A7 | 2.5 | Ed3, spike, S2 |
| A4 | `THIS^.member` | **Ext.** 6.6.5.7 describes THIS as a reference to the own instance, used as `THIS.` with a method. Annex A allows `THIS.` before a variable (`Symbolic_Variable`) and before a method (`Invocation`). No caret form appears anywhere in Ed3. | Parse error. `THIS.x` passes; bare `THIS^` passes under `iec` (R). | Feature `self_caret` | 0.5 | Ed3, doc, spike, S2 |
| A5 | `REF=` on a THIS member | **Ext.** Ed3 has no `REF=`: a reference is assigned with `:=` (`Ref_Assign`), and `?=` is an assignment attempt. | Parse error (S) | Existing feature `ref_assign` | 0.5 | Ed3, spike, S2 |
| A6 | `PROPERTY` in an `INTERFACE` | **Not in Ed. 3**: 3.55 has an interface hold method prototypes only, and Annex A's `Interface_Decl` takes only `Method_Prototype`. Ed3 has no PROPERTY construct at all. **In Ed. 4**: 3.53 adds property prototypes. | `Expected END_INTERFACE, found PROPERTY` (S) | Feature `property` | 2 | Ed3, doc, spike, S2 |
| A7 | GVL-qualified access `GVL_X.var` | **Ext.** In Ed3, global variables live in CONFIGURATION, RESOURCE and PROGRAM (`Global_Var_Decls`). Namespaces (6.9; Annex A `Namespace_Elements`) may hold types, functions, FBs, classes, interfaces and namespaces, but **not variables**. So a namespace wrapper is not IEC either. | `Undeclared variable 'GVL_A'` (S) | Feature `named_global_lists`; the caller supplies list names | 2.5 | Ed3, doc, spike, S2 |
| A8 | `TYPE X EXTENDS B : STRUCT` | **Ext.** `Struct_Type_Decl` takes no EXTENDS. 3.46 limits inheritance to classes, FB types and interfaces. 6.4.4.6 makes two structured variables assignment-compatible only if they have the same type. Ed. 4: n.e.i. | `Expected Colon, found EXTENDS` (S) | Feature `struct_extends` | 2 | Ed3, doc, spike, S2 |
| A9 | `UNION … END_UNION` | **Ext.** No UNION in Ed3. The IEC overlay mechanism is `STRUCT OVERLAP` with relative `AT` locations (6.4.4.7, Table 11; `Struct_Decl`), see B9. | Parse error (S) | Feature `union_type`; `union` must stay usable as a name under `iec` | 3 | Ed3, doc, spike, S2 |
| A10 | Enum base written after the list, `( … ) DINT` | **Variant.** 6.4.4.3 and Annex A `Enum_Type_Decl` put the optional elementary base type **before** the named-value list. | `Expected Colon, found ;` (S). The base-first form passes. | Feature `postfix_enum_base` | 0.5 | Ed3, doc, spike, S2 |
| A11 | FB instance with init arguments `fb : FB_T(p := v)`, and FB_init running | **Ext.** 6.6.3.3 and Table 41 (feature 2), plus Annex A `FB_Decl_Init`: IEC instance initialisation is `:=` followed by a parenthesised list that sets inputs, outputs or public variables. Ed3 has no initialisation method. | Parse error. The IEC form `fb : FB_A := (p := 3)` passes (S). A method named FB_init compiles but never runs (D, ran). | Feature `fb_init`, plus a warning when FB_init is declared with the feature off | 3 | Ed3, doc, spike, S2 |
| A12 | Enum qualified as `E_X.Member` (dot), used by the sample | **Variant.** 6.4.4.2 and 6.4.4.3 and Annex A `Enum_Value` qualify with `Type#Member` only. | Accepted under `iec` (R): a leak that the sample relies on | No S2 work. If the iec audit narrows it, it needs a feature (for example `enum_dot_qualify`) that the sample's profile enables. | – | Ed3, doc, re-run |
| A13 | Lexer errors at `0:0` | Defect | `pragma.st:0:0` (S), `ltime.st:0:0` (R) | Fix | 0.5 | doc, spike, S2 |
| A14 | Check-only CLI with JSON; warnings shown on failure | n/a | No check mode. Warnings are printed only on success (doc, S2). | `--check --json`; print warnings on failure in every mode | 1 | doc, spike, S2 |
| A15 | Interface-typed variables: `i := f`, locals, FB members, FB inputs | **IEC.** 6.6.6.5: an interface type may type a variable, which then refers to an implementing instance. NULL is its initial value; it may be assigned an implementing or derived instance or another such variable, and compared for equality. Annex A has `Interface_Var_Decl` and `Interface_Spec_Init`. The 6.6.5.7.2 example passes THIS into an interface-typed FB input. | `i := f` → `Cannot assign FB_A to I_A` (R). An interface VAR_INPUT passes the ST step and then **fails in g++** (abstract type, R `--build`). A method VAR_IN_OUT builds and runs (R `--build`). `i = NULL` passes the ST step (R). | Defect | 2 (1.5–2.5) | Ed3, doc, S2 (corrected) |

### 1b. Under `iec`: standard code the fork refuses (defects)

Fixing these only widens what the compiler accepts.

| # | Construct | Status: Ed3 clause | At a529ea9 | Effort | Sources |
|---|---|---|---|---|---|
| B1 | `SUPER.M()` | IEC: 6.6.5.7.3 and its examples. Annex A's `Invocation` omits it, an inconsistency inside Ed3. `SUPER()` in an FB body is 6.6.7.2.9. | `Unexpected SUPER` (R) | 0.5 | Ed3, doc |
| B2 | Chained comparison `a = b = TRUE` | IEC: Annex A `Compare_Expr` and `Equ_Expr` repeat; Table 71 groups the comparison operators. The doc notes the precedence levels in Table 71 and Annex A disagree. | Parse error in every mode (R) | 0.5 | Ed3, doc |
| B3 | `CHAR`, `WCHAR` | IEC (6.4.2, Table 10) | `Undefined type 'CHAR'` (R) | 1–1.5 | doc, re-run |
| B4 | `LTIME`, `LTIME#` | IEC (6.3.4, Table 8, Table 10) | `LTIME#` gives a lexer error (R) | 2+ | doc, re-run |
| B5 | String index `s[i]` | IEC (6.4.2.2, per the doc) | Passes the ST step, then fails in g++ (R `--build`) | ~1, after B3 | doc, re-run |
| B6 | `STRING[n]` | Ed3's own example in Table 14 uses brackets. The doc says the prose of 6.4.2.2 uses parentheses, so Ed3 is inconsistent. | Parse error (R) | 0.5 | Ed3, doc |
| B7 | Typed `TRUNC_<type>` | IEC (Table 22, 2b/2c, per the doc) | Fails in g++ (D) | – | doc |
| B8 | Literal-only string functions, literal `ROL`, constant `STRING(cM)`, symbolic CASE labels and subrange bounds | IEC | Fail only in g++ (D) | – | doc |
| B9 | `STRUCT OVERLAP` (with relative `AT`) | IEC (6.4.4.7, Table 11; `Struct_Decl`) | `TYPE S : STRUCT OVERLAP …` gives a parse error under `iec` (R) | – (shares the overlay codegen with A9) | Ed3, re-run |

### 1c. Under `iec`: accepted but should not be (leaks)

Each of these narrows what is accepted, so each needs the "what does `iec` mean" decision first.

| # | Construct | Ed3 | At a529ea9 | Sources |
|---|---|---|---|---|
| C1 | FB `PROPERTY` (and in an interface, once A6 lands) | Not in Ed3 (see A6) | Accepted under `iec` (R) | Ed3, doc |
| C2 | `ACTION` in ST, direct calls, `Owner.Name` | SFC only (6.7.4, Table 56, per the doc) | Accepted under `iec` (R) | doc |
| C3 | Bare `THIS^`, `SUPER^.M()` | Ext (see A4) | Accepted under `iec` (R). The fork's `DIALECTS.md:79` and `IEC_COMPLIANCE.md:209` call them IEC, which is **wrong** against Ed3. | Ed3, doc |
| C4 | Default access hard-coded PUBLIC | 6.6.5.4.3, 6.6.5.9, 6.6.5.10, 6.6.3.2, Table 53 (per the doc) | `f.v`, `f.M()` accepted (R) | doc |
| C5 | Identifiers `__n`, `a__b`, `c_` | Invalid (6.1.2, Table 2, per the doc) | Accepted (R) | doc |
| C6 | Override without `OVERRIDE` | Required (Table 53 feature 8, per the doc) | Accepted (R) | doc |
| C7 | Enum `E.Member` dot form | Variant (see A12) | Accepted (R) | Ed3, re-run |
| C8 | Rounding half away from zero; `{external}`; `__NEW`; `VAR_INST`; `ADR` in an index; `1E-4`; assigning the FOR variable; optional `VAR_EXTERNAL`; octal, IL, plain TRUNC | per the doc's table | (D) | doc |
| C9 | `--test` files ignore the dialect | – | (D; also stated in `DIALECTS.md`) | doc |

### 1d. Doc findings outside S2 (not re-run)

- **Runtime defects:**
  - SIGSEGV on a REFERENCE TO input;
  - SIGFPE on `/0` and `MOD 0`;
  - abort on an out-of-range index;
  - SEL evaluates both inputs;
  - VAR_TEMP keeps its value between calls;
  - the VAR_INST initialiser is ignored;
  - FB_exit is never called;
  - WSTRING_TO_STRING crashes;
  - TIME, DATE and BOOL to-string forms are wrong;
  - SIZEOF and POINTER stride are inflated by the wrapper;
  - no runtime subrange check;
  - intermediates are 32-bit;
  - initialiser order and string truncation fail silently.
- **Profile handling:**
  - a file with `id: "iec"` and extra features reports itself as `iec`;
  - several files with no selection give the default silently;
  - with duplicate ids, the first wins silently;
  - one bad JSON file in `--dialect-path` stops every compile.
- **Strict mode** refuses forms a correct vendor project uses:
  - BYTE and WORD arithmetic;
  - `END_IF` and similar with no `;`;
  - `DINT := SIZEOF(x)`;
  - a FUNCTION called as a statement;
  - several implicit conversions.

## 2. Agreements, contradictions, corrections

1. **PROPERTY: settled.** Ed3 has none: 3.55 and Annex A `Interface_Decl` define an interface as method
   prototypes only, and PROPERTY appears nowhere in the Ed3 text. Ed. 4's 3.53 adds property prototypes.
   - The doc ("not an Ed. 3 construct, a leak under iec") and S2 ("standard in Ed. 4") were each right for
     their edition.
   - **Revised:** interface PROPERTY ships behind feature `property`, not always-on. FB PROPERTY stays
     accepted in every profile during S2, so nothing narrows. Refusing it under `iec` (C1) belongs to the
     iec audit. That step must also add `property` to `DEFAULT_FEATURES`, so no-flag builds keep accepting
     it.
2. **THIS^ / SUPER^: S2 corrected.** S2 followed the fork's `DIALECTS.md`, which calls `THIS^` IEC.
   - Ed3 has no caret form. THIS and SUPER are used with a dot (6.6.5.7.2–.3; Annex A `Symbolic_Variable`,
     `Invocation`), and `SUPER()` calls the base body (6.6.7.2.9). The doc said the same.
   - So `THIS^.member` goes behind a feature (`self_caret`), `SUPER.` is a missing IEC form (B1), and the
     fork's docs are wrong (C3).
   - As the doc says, `SUPER^` must not be refused before `SUPER.` exists.
3. **Pragmas: agree, settled.** 6.2 and Table 4 confirm the doc's and S2's reading. S2's secondary source
   was accurate.
   - Ed3 leaves the contents to the implementer, so a "pragma ignored" warning plus an error for
     conditional pragmas is a conforming choice.
   - The doc adds that `{external}` passes under `iec` (C8), and that 12 of its 57 pragma features still
     fail once the pragma is removed.
4. **FB init arguments and FB_init: agree, settled.** 6.6.3.3, Table 41 and `FB_Decl_Init` give the IEC
   form `:= ( … )`, which already works.
   - The parenthesised argument list straight after the type, and any initialisation method, are vendor
     forms.
   - The doc ran it: an FB_init body never runs, even on `__NEW`.
   - **Added:** with `fb_init` off, an FB that declares FB_init gets a warning that it will not be called.
     That is a warning, not a refusal, so no profile narrows.
   - The doc's secondary reading answers part of S2's FB_init question: two implicit BOOL inputs, base
     before derived, nested order undefined.
5. **Interface-typed variables: S2 was wrong, the doc right; now settled as IEC (6.6.6.5).**
   - S2's "interface parameters work" was an ST-step result. Under g++ an interface VAR_INPUT fails, and
     only a method VAR_IN_OUT builds.
   - This is a plain defect under `iec`, and it is promoted into the S2 core (A15).
   - It also means the **check path can pass code that does not build** (Q10).
6. **Member-chain calls: settled for instance chains.** Annex A `Invocation` allows repeated instance-name
   prefixes, so `a.b.M()` over FB or class instances is IEC.
   - A struct field holding an FB is not covered by that production. Its IEC status is n.e.i. I propose it
     always-on with the chain, because a struct field of FB type is still an FB instance (6.4.4.6 and
     6.6.3.3 both treat FB instances like structured variables).
   - Flag this to the user (Q9).
7. **GVL names: settled as Ext.** Ed3 namespaces cannot hold variables (`Namespace_Elements`), so S2's idea
   of a NAMESPACE wrapper as an IEC route is ruled out. A feature with caller-supplied names stays.
8. **STRUCT EXTENDS, UNION and the postfix enum base: all settled as Ext or Variant.**
   - S2's "n.e.i." for STRUCT EXTENDS is closed for Ed3 (3.46, `Struct_Type_Decl`). Ed. 4 stays n.e.i.
   - 6.4.4.6's same-type assignment rule answers S2's derived-to-base question for Ed3: no.
   - New: Ed3's own overlay form, `STRUCT OVERLAP`, is also missing (B9). UNION and OVERLAP should share one
     overlay lowering in C++ generation.
   - The fork's `UNION_IMPLEMENTATION_PLAN.md` ("behind no flag") is overridden by the hard rule.
9. **Enum dot qualification: new.** The sample uses `E_StationState.Running`. Ed3 qualifies with `#` only.
   It passes under `iec` today, which is a leak (C7, A12). Nothing to do in S2, but the iec audit must not
   take it away from the sample's profile.
10. **Gated keywords (doc).** Keywords are global in the fork. A new gated keyword such as `UNION` or
    `END_UNION` must stay a valid identifier when its feature is off, and its refusal must still name the
    feature.
11. **Gate placement (doc).** The doc warns that `walkAST` has no actions entry. At `a529ea9` actions are
    lowered to methods, and `REF=` inside an ACTION is refused under `iec` (R). New gates use
    `requireFeature` in the analyzer, as the existing four do.
12. **Fork doc drift.** `IEC_COMPLIANCE.md` is wrong on interface PROPERTY (doc and S2), LTIME and runtime
    subrange checks (doc), pragmas `:197/:204/:206` (S2), and `THIS^`/`SUPER^` as IEC (`:209`, and
    `DIALECTS.md:79`). Each PR fixes the rows it touches.

## 3. Revised S2 proposal

S2 stays a **bounded list**: what the sample needs, plus the defects under `iec` that sit on the same code.
The doc's 224/236-feature table is explicitly not a to-do list (55–150 d), and S2 takes nothing else from it.

Rules for every step:
- New features go into `KNOWN_FEATURES`, never into `DEFAULT_FEATURES`.
- Nothing any profile or the no-flag default accepts today is refused.
- Each PR follows the fork's process rules: a branch from `development`, unit, e2e and manual evidence, a
  local lint, format, typecheck, build and coverage run, and docs updated in the same PR.

### S2 core: "IEC + sample", about 22 d

| Step | PR | Content | Effort |
|---|---|---|---|
| 1 | Diagnostics plumbing | A13 lexer positions (one error converter; the parser runs after lexer errors); A14 `--check --json`; warnings on failure in every mode | 1.5 |
| 2 | Pragmas | A1, and the `IEC_COMPLIANCE.md` pragma rows | 1 |
| 3 | Self and super forms | B1 `SUPER.` (always-on); A4 `self_caret`; A5 `REF=` on THIS members under `ref_assign`; correct `DIALECTS.md:79` and `IEC_COMPLIANCE.md:209` | 1.5 |
| 4 | Member-chain calls | A3: instance chains, struct-held FBs, `arr[i].M()` | 2.5 |
| 5 | Interface variables | A15: locals, members, inputs, `i := f`, NULL and equality; C++ as a non-owning reference | 2 |
| 6 | Interface properties | A6 under `property`; the e2e goes through an interface variable (after step 5) | 2 |
| 7 | Chained comparisons | B2. The precedence choice needs a decision first (Q8). | 0.5 |
| 8 | Postfix enum base | A10 `postfix_enum_base` | 0.5 |
| 9 | Named global lists | A7 `named_global_lists`; `qualified_only` not enforced | 2.5 |
| 10 | Struct inheritance | A8 `struct_extends`; derived-to-base assignment refused | 2 |
| 11–12 | UNION | A9 `union_type`: (a) tokens kept usable as identifiers, parser, analysis; (b) an overlay lowering in C++ that B9 can reuse later, plus the e2e | 3 |
| 13 | FB_init | A11 `fb_init`, plus the warning when the feature is off | 3 |

**About 22 d** (21.5–23).

- Against the first S2 design (19 d), this adds A15 (+2), B1 (+0.5), B2 (+0.5) and plumbing (+0.5), and
  turns S2's always-on `THIS^` and interface PROPERTY into features (no change in effort).
- **Milestones:**
  - after step 2 (**2.5 d**), R3.2 can use `--check --json`, and every sample file reaches analysis;
  - after step 6 (**11 d**), the IEC gaps the sample hits are closed, along with the interface defect;
  - after step 13, the sample compiles with no workarounds under a profile that adds `self_caret`,
    `property`, `postfix_enum_base`, `named_global_lists`, `struct_extends`, `union_type` and `fb_init` to
    the existing four.
- **R3.2's own converter work is unchanged:**
  - put members before the body (A2);
  - supply the GVL list names;
  - blank pragmas and rewrite the postfix enum base as stopgaps until steps 2 and 8 ship.

### Separate later items (not S2)

| Item | Content | Size |
|---|---|---|
| IEC Ed. 3 refusals | B3 CHAR/WCHAR, B4 LTIME, B5 string index, B6 `STRING[n]` (after the decision), B7 typed TRUNC, B8 g++-only failures, B9 `STRUCT OVERLAP` | about 7–10 d, not measured |
| iec audit (narrowing) | C1–C9. Depends on what `iec` means and on keeping the no-flag default stable. | not sized; the doc expects bench and library rewrites first |
| Runtime safety | §1d runtime defects | not sized |
| Profile handling | §1d profile defects | about 1 d, not measured |
| Strict-mode policy for vendor profiles | which strict checks a profile relaxes | decision first |
| Ed. 4 profile | after a full Ed. 4 read | not sized |
| Vendor-feature catalogue | the rest of the 224/236 list | explicitly not a plan |

## 4. Open questions

1. **What does `iec` mean: Ed. 3, or Ed. 4?** The doc recommends Ed. 3 now and Ed. 4 later; this design
   assumes that. If the answer is Ed. 4, `property` becomes always-on.
2. **May S2 widen what `iec` accepts for IEC forms?** That covers `SUPER.`, chained comparisons,
   interface variables, instance-chain calls and pragma delimiters. All narrowing is deferred to the iec
   audit.
3. **A15 (interface variables) in the S2 core?** It is an IEC defect, and S2 cannot test interface
   properties end to end without it.
4. **CLI shape:** `--check --json`, or `--check --diagnostics-format=json`?
5. **`qualified_only`:** leave it unenforced in `named_global_lists` v1?
6. **An interface PROPERTY without GET/SET markers:** both accessors, or GET only? Ed3 has no PROPERTY and
   the Ed. 4 body text was not read, so neither source settles it.
7. **FB_init:** which reference fixes the implicit flag values per start type and the init order of globals
   across lists, given that the fork may not cite a vendor?
8. **Chained-comparison precedence:** Table 71 or Annex A? The doc reports they disagree. That needs
   deciding before step 7.
9. **FB held in a STRUCT field:** accept `s.fb.M()` always-on together with instance chains, though Annex A
   names only instance prefixes?
10. **What "clean" means in R3.2:**
    - The check runs the ST analysis only, and code can pass it and still fail in g++ (A15, B5, B8).
    - Should R3.2 say so in its UI?
    - Should `--check` later gain a C++ generation or g++ syntax-only pass?
11. **Feature ids:** `self_caret`, `property`, `postfix_enum_base`, `named_global_lists`, `struct_extends`,
    `union_type`, `fb_init` (and possibly `enum_dot_qualify` later). Should they be aligned with the user's
    dialect-catalogue naming before step 3? Renaming a shipped id breaks profiles.
12. **Process:** the fork needs a Jira key per branch. Is S2 one demand with 13 PRs, or one per step?
