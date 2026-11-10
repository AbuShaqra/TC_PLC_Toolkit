# sample/ — the synthetic TwinCAT project the test suite gates on

Two **wholly synthetic** TwinCAT solutions. They contain no customer code and no Beckhoff binaries, so
they are committed — which is the point: the diagnostics ratchet and the live-path guard run on CI and on
a fresh clone instead of skipping.

| Solution | Layout | PLC project | Objects |
|---|---|---|---|
| `TcToolkitSample/` | TwinCAT 3.1.4026 (`.sln` + `.tsproj` + `_Config/`) | `TcToolkitSample_PLC` | 19, plus the library fixtures below |
| `TcToolkitSample2/` | TwinCAT 3.1.4024 (`.sln` + a single-file `.tspproj`) | `TcToolkitSample2_PLC` | 7 |

Together they make `sample/` a **multi-project workspace**: both have a `MAIN`, and both have an
`FB_Cylinder` with different code, so anything that is not scoped per project gives a wrong answer.

They are **ground truth**: the code is correct, so *any* diagnostic reported on either is a bug in the
extension. They measure **0** against a baseline of **0**, and the external compiler check
(`test/test_compile_real.js`) reports 0 errors on both.

## How it is produced

Two steps, both reproducible:

1. **`scripts/Create sample PLC project/build-sample-solution.ps1`** drives TwinCAT XAE's automation
   interface once to create the `.sln`, `.tsproj` and an empty `.plcproj`. Only TwinCAT can write those
   correctly — the template on disk is a 67-byte stub that TwinCAT expands at insertion time, and
   hand-writing them produced a project XAE refused to open. Requires TwinCAT; run rarely.
2. **`scripts/Create sample PLC project/build-sample-project.js`** writes the 19 PLC objects and
   *injects* their `<Compile>` and `<Folder>` entries into XAE's `.plcproj`, leaving its identity
   GUIDs, library references and options archive untouched. Deterministic and idempotent — no TwinCAT
   needed.

### The second solution

**`scripts/Create sample PLC project/build-sample-project2.js`** generates all of `TcToolkitSample2/`,
no TwinCAT needed: the skeleton comes from the extension's own 3.1.4024 template (the code behind
*TwinCAT: Create New Project…*, with identity GUIDs derived deterministically), and the 7 objects are
rendered and registered by the first script's emitter. `--check` compares the committed tree with a fresh
build (the test suite runs it); `--write` rewrites the generated files in place.

## What is and is not committed

Committed: the solution/system/PLC project files, the 19 objects, XAE's `PlcTask.TcTTO`, `_Config/`;
and everything `build-sample-project2.js` writes for `TcToolkitSample2/`. Not committed for the second
solution: anything XAE adds when you build it (`.tmc`, `_Libraries/`, `_CompileInfo/`, …).

Not committed: `_CompileInfo*/`, `ST_Files/`, `.vs/`, `*.bak`, and the **Beckhoff** library archives
TwinCAT copies into `_Libraries/` (`Tc2_Standard`, `Tc2_System`, `Tc3_Module`). The `.plcproj` still
*references* them, which is what the namespace indexer reads; the archives themselves are Beckhoff's
to distribute, not ours. Their absence is expected and the harnesses gate on it.

## Third-party content

One library archive **is** committed, because its licence permits redistribution:

| | |
|---|---|
| Library | TwinCAT Dynamic Collections |
| Namespace | `TcDynCollections` |
| Version | 1.0.7 |
| Author | FisoThemes |
| Source | https://github.com/fisothemes/TwinCAT-Dynamic-Collections |
| Licence | MIT |
| Path | `TcToolkitSample_PLC/_Libraries/fisothemes/twincat dynamic collections/1.0.7/tcdyncollections.library` |

It is here so the library-symbol machinery (the ZIP reader, the `__shared_data_storage_string_table__`
parser, namespace attribution) is exercised against a **real** archive on every CI run. Without it no
readable archive exists anywhere in the tree and those harnesses skip. The MIT licence requires the
copyright notice be retained; it travels inside the archive and is acknowledged here.

If you add another third-party archive, check its licence first and record it in this table.
