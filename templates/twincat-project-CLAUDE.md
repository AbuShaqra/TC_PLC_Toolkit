# CLAUDE.md — TwinCAT PLC project

Field guide to this repository's file formats. Read it before touching any `.TcPOU`, `.TcGVL`,
`.TcDUT`, `.TcIO` or `.plcproj`. The traps below are all real; each one has burned someone.

## What the files are

This is a **Beckhoff TwinCAT 3** PLC project. The code is **Structured Text (IEC 61131-3)**, but it is
not stored as source files — every object is an **XML wrapper with the ST buried inside
`<![CDATA[ ... ]]>` blocks**. TwinCAT owns that XML: it writes the metadata, the ordering, the GUIDs
and the line bookkeeping, and it will happily rewrite the whole file if you disturb them.

One object = one file:

| Extension | Root element | Holds |
|---|---|---|
| `.TcPOU` | `<POU>` | `FUNCTION_BLOCK`, `PROGRAM` or `FUNCTION` |
| `.TcGVL` | `<GVL>` | a `VAR_GLOBAL` list |
| `.TcDUT` | `<DUT>` | `STRUCT` / enum / `UNION` / alias |
| `.TcIO` | `<Itf>` | an `INTERFACE` |
| `.TcTLEO` | `<EnumerationTextList>` | an enum whose members also carry display text — its `<Declaration>` is an ordinary `TYPE X : (…); END_TYPE`, i.e. a DUT in every way that matters |

Other `.Tc*` files exist (`.TcTTO` tasks, `.TcVMO`/`.TcVIS` visualisations, `.TcGTLO` text lists). They
are not ST; leave them alone unless asked.

## XML anatomy

```xml
<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_StackLight" Id="{a1f0c3d2-…-2e5d8f0b1a01}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_StackLight
VAR
    refRed  : REFERENCE TO BOOL;
    fbBlink : FB_Blink;
    _bError : BOOL;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Folder Name="Methods" Id="{5e4df96d-…}" />
    <Property Name="bError" Id="{…f1}">
      <Declaration><![CDATA[{attribute 'monitoring' := 'variable'}
PROPERTY bError : BOOL]]></Declaration>
      <Get Name="Get" Id="{…f2}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation><ST><![CDATA[bError := _bError;]]></ST></Implementation>
      </Get>
    </Property>
    <Method Name="SetRed" Id="{…a07}" FolderPath="Methods\">
      <Declaration><![CDATA[METHOD SetRed : BOOL
VAR_INPUT
    bOn : BOOL;
END_VAR]]></Declaration>
      <Implementation><ST><![CDATA[bRedCmd := bOn;]]></ST></Implementation>
    </Method>
    <LineIds Name="FB_StackLight.SetRed">
      <LineId Id="2" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
```

Rules that follow from that shape:

- **Only a POU has an implementation.** `<GVL>`, `<DUT>` and `<Itf>` carry a `<Declaration>` and
  nothing else. A POU's body is `<Implementation><ST><![CDATA[…]]></ST></Implementation>`.
- **Child elements of a POU/Itf**: `<Method>`, `<Property>` (whose own `<Declaration>` is just the
  signature — the code lives in nested `<Get>` / `<Set>`, each with its own `<Declaration>` and
  `<Implementation>`), `<Action>` (implementation only — an action has *no* declaration), and
  `<Transition>` (SFC).
- **Inside an interface** (`.TcIO`) methods and accessors have a `<Declaration>` and **no**
  `<Implementation>` — an interface declares, it does not implement.
- `<Folder>` elements plus the `FolderPath="Methods\Internal\"` attribute are TwinCAT's **virtual
  folders inside an object**. They are not disk folders and do not affect scope. Backslash-separated,
  trailing backslash included.
- The ST inside a CDATA block therefore may never contain the sequence `]]>`.

## The rule that matters most: edits must be surgical

**Change the text inside the one CDATA block you mean to change, and nothing else. Byte for byte.**
TwinCAT and Git both diff these files; any incidental change shows up as a spurious diff, and TwinCAT
may treat a mangled object as changed code and force an online-change/rebuild.

Never do these, however tempting:

- **Do not reformat or pretty-print the XML.** Indentation, attribute order and self-closing style are
  TwinCAT's.
- **Do not touch `Id="{…}"` GUIDs.** They identify objects across builds and in the `.plcproj`.
- **Do not renumber, reorder or delete `<LineIds>`.** They are TwinCAT's line bookkeeping for online
  change, keyed `Name="Root"` / `Name="Root.Member"` / `Name="Root.Prop.Get"`. They are stale the
  moment you edit the code — that is fine and expected; TwinCAT rewrites them itself. Fabricating or
  "fixing" them is worse than leaving them alone. Delete a `<LineIds>` block only when you delete the
  component it names.
- **Do not normalise encodings or line endings.** These files are CRLF, and whether a file starts with
  a UTF-8 BOM varies file by file (in one real 152-object project: 93 with, 59 without). Rewriting a
  file with different endings or a stripped BOM makes every line show as changed.
- **Do not re-sort child elements.** TwinCAT writes sub-objects alphabetically
  (`SubObjectsSortedByName` in the `.plcproj`); a new method belongs in that order, not at the end.

A safe edit is: locate the exact `<![CDATA[` … `]]>` span of the component you want, splice new text
between those delimiters, write the file back unchanged elsewhere. Prefer a targeted string
replacement over any XML DOM round-trip — a DOM parser will re-quote attributes, drop the BOM and
re-indent, and you will have rewritten the file.

## Telling the object kinds apart

Classify from the **declaration text**, after stripping comments and pragmas (a comment saying
"replaces the old FUNCTION" must not decide anything).

A `.TcPOU` is one of:
- `PROGRAM Name` — singleton, called by a task.
- `FUNCTION Name : RetType` — stateless, has a return type.
- `FUNCTION_BLOCK Name` — instantiable, stateful; the default.

**Trap:** `FUNCTION_BLOCK` *contains* the word `FUNCTION`. Test for `FUNCTION_BLOCK` first, or match
`FUNCTION` only when not followed by `_BLOCK`.

A `.TcDUT` is one of:
- `TYPE X : STRUCT … END_STRUCT END_TYPE` — a structure. May `EXTENDS` another struct:
  `TYPE ST_AxisErrors EXTENDS ST_Errors : STRUCT …`.
- `TYPE X : UNION … END_UNION END_TYPE` — overlapping members.
- `TYPE X : (A := 0, B, C) DINT; END_TYPE` — an **enum**: the body opens with `(`. The base type after
  the `)` is optional.
- `TYPE X : DWORD; END_TYPE` / `TYPE X : STRING(80); END_TYPE` — an **alias**.

**Traps:** `END_STRUCT` / `END_UNION` contain `STRUCT` / `UNION` — a naive substring test finds them
in every struct's terminator, so anchor on word boundaries. And an alias is not "anything without a
paren": `TYPE T : STRING(80);` has a paren and is still an alias. What decides is whether the body
*starts* with `(`.

## Structured Text facts that bite

- **ST is case-insensitive.** `fbPump`, `FBPUMP` and `FbPump` are one symbol; so are `if` and `IF`.
  Any search, rename or reference hunt that is case-sensitive is wrong.
- **A method's `VAR` block is private to that method.** A variable declared inside a `METHOD` exists
  only in that method — nothing in another method, another POU or another file can name it. An FB's
  own `VAR` members are the opposite: they are reachable from outside through an instance
  (`fbAxis.bDone`). Do not conflate the two when tracing a symbol.
- **But a method's `VAR_INPUT` / `VAR_OUTPUT` / `VAR_IN_OUT` are NOT private** — they are its
  *parameters*, and call sites name them from anywhere: `fbAxis.MoveAbsolute(fVelocity := 5, bDone => bOk)`.
  So `bDone` may be declared as a `VAR_OUTPUT` in a dozen methods of the same FB, and each one is a
  *different symbol*: `Halt`'s `bDone` and `Stop`'s `bDone` share only a name. When a method calls
  another (`Reset(bDone => bStepDone)`), that `bDone` belongs to **Reset**, not to the caller. Any
  rename or reference hunt that ignores which method owns the parameter will be wrong, in both
  directions.
- **`GET` and `SET` are keywords, but methods are named `Get` and `Set` all the time.** They are
  property accessors *only* at the head of a declaration inside a `PROPERTY`. Everywhere else they are
  ordinary identifiers — `fbQueue.Get(Item := n)` is a plain method call on a Tc3 `FB_Queue`. A tool
  that treats every `GET` as an accessor and scans forward for `END_GET` will swallow the rest of the
  method and everything after it. (This exact bug hid 24 of one FB's 44 methods from a language
  server.) The same caution applies to any keyword that can be a member name.
- **The two declaration-site initialisation syntaxes bind to different things:**
  - `inst : FB_T(p := v);` passes `p` to **`FB_T`'s `FB_init` method** (whose parameters are that
    method's `VAR_INPUT`, and which may be *inherited* from a base FB). TwinCAT always also accepts
    the implicit `bInitRetains` / `bInCopyCode`.
  - `inst : FB_T := (p := v);` initialises **the FB's own `VAR_INPUT`**.

  They look alike and are not. Read the FB before assuming which parameters are legal.
- **VAR block kinds** in use: `VAR`, `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR_GLOBAL`, `VAR_TEMP`,
  `VAR_STAT`, `VAR_EXTERNAL`, `VAR_INST`, `VAR_CONFIG`, with the modifiers `CONSTANT`, `RETAIN`,
  `PERSISTENT`. `VAR_INST` inside a method is a *method-scoped variable that keeps its value between
  calls* — it is stored on the instance, not on the stack.
- **`AT %I*` / `AT %Q*` / `AT %MB100`** after a variable name is a direct-address binding, legal in a
  VAR block and in a STRUCT/UNION body: `b_stop AT %I* : BOOL;`.
- **Pragmas are `{ … }` metadata, not code**, and always on their own line. The ones that change
  meaning: `{attribute 'qualified_only'}` on a GVL or enum **forces the prefix** — with it,
  `GVL_Mode.b_active` and `E_State.IDLE` are the only legal spellings, and a bare `b_active` will not
  compile. Others are annotations (`{attribute 'monitoring' := 'variable'}`, `{attribute 'strict'}`,
  `{attribute 'to_string'}`) and `{region "…"}` / `{endregion}` are folding markers.
- **OO extensions**: `EXTENDS` (single inheritance) and `IMPLEMENTS I_A, I_B` on a `FUNCTION_BLOCK`;
  `EXTENDS` on an `INTERFACE`; `ABSTRACT` / `FINAL` and `PUBLIC` / `PRIVATE` / `PROTECTED` / `INTERNAL`
  sit **between the keyword and the name** (`FUNCTION_BLOCK ABSTRACT FB_Axis IMPLEMENTS I_Axis`), so
  the name is not always the second token. `THIS^` and `SUPER^` are the self/base references.
- **TwinCAT-only operators**: `REF=` (reference assignment: `THIS^.bSignal REF= bSignal;`),
  `AND_THEN` / `OR_ELSE` (short-circuit), `__ISVALIDREF(ref)` (a `REFERENCE TO` may be unbound —
  guard before use), `ADR`, `SIZEOF`, `__NEW`.
- **Literals**: time/typed literals use `#` — `T#500MS`, `LTIME#…`, `TOD#12:00:00`, `DT#…`, and based
  numbers `16#FFFFFFFF`, `2#1010`. `T#500MS` is one token, not `T`, `#`, `500MS`.

## Project skeleton

- **`*.plcproj`** — the project file (MSBuild XML). It is the **object list**: every source object has a
  `<Compile Include="POUs\Foo\FB_Bar.TcPOU"><SubType>Code</SubType></Compile>` entry, and every disk
  folder a `<Folder Include="…">`. **A `.TcPOU` that is not listed here does not exist to TwinCAT.**
  When you add, rename, move or delete an object you *must* update the `.plcproj` in the same change.
  Paths are backslash-separated and relative to the `.plcproj`.
  It also declares the library references, in two shapes:
  ```xml
  <PlaceholderReference Include="System_VisuElems">
    <DefaultResolution>VisuElems, 4.8.0.0 (System)</DefaultResolution>
    <Namespace>VisuElems</Namespace>
  </PlaceholderReference>
  <LibraryReference Include="Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH">
    <Namespace>Tc2_EtherCAT</Namespace>
  </LibraryReference>
  ```
  The `<Namespace>` is **the name you type in ST** — and it is often none of the other names. TwinCAT's
  recipe library is `RecipeManagement` in the project file, `Recipe Management` by title, and
  `Recipe_Management` in code.
- **`_Libraries/`** — vendored library archives, laid out `<company>/<title>/<version>/`.
  `.compiled-library`, `.compiled-library-ge33` and `.library` are ZIP containers.
  **`.compiled-library-v3` is an opaque non-ZIP format** (magic `10 a6 d5 a7`) and cannot be read by
  anything but TwinCAT. Do not try to parse or edit any of them.
- **`*.tmc`** — the TwinCAT type-system export: plain XML, one enormous line, `<DataType>` blocks with
  fields, enum values, methods and base types for the types the project actually *uses*. **Generated
  by the build — never hand-edit it.** It is the only readable description of library type structure.
- **`_CompileInfo/`, `_CompileInfo_Upload/`** — build output. Large, derived, disposable.
- **`ST_Files/`** — if present, **generated `.st` exports** of the objects (they carry a "Generated
  clean version stripping XML wrappers" header). They are a *read-only view*, and they are not
  round-tripped: editing one changes nothing, and the next export overwrites it. **The `.Tc*` XML is
  the source of truth.**

Derived, so usually git-ignored: `_CompileInfo*/`, `ST_Files/`. `_Libraries/` and the `.tmc` are often
ignored too (they are bulky and machine-generated), which means a fresh clone can be missing every
library symbol — check that before concluding a type "does not exist".

## Working here

1. **The real code is inside the CDATA blocks.** Grep the `.Tc*` files themselves, case-insensitively,
   across all four extensions — a type used in a POU is usually declared in a `.TcDUT` or a library, not
   nearby. `ST_Files/` is easier to read if it exists, but it is never authoritative and never edited.
2. **When you add an object, update the `.plcproj`.** When you delete one, remove its `<Compile>` entry;
   its `<LineIds>` go with the file.
3. **When you add a method/property to a POU**, add the child element inside the existing `<POU>`, with
   a fresh GUID in `Id`, in alphabetical position, indented like its siblings — and leave every other
   byte of the file alone.
4. **An unresolved name is usually a library symbol, not a bug.** Before "fixing" an identifier you
   cannot find, check the `.plcproj` namespaces and the `.tmc`.
