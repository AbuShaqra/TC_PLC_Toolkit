# sample/ — the synthetic TwinCAT project the test suite gates on

`TcToolkitSample/` is a **wholly synthetic** TwinCAT solution. It contains no customer code and no
Beckhoff binaries, so it is committed — which is the point: the diagnostics ratchet and the live-path
guard run on CI and on a fresh clone instead of skipping.

It is **ground truth**: the code is correct, so *any* diagnostic reported on it is a bug in the
extension. It measures **0** against a baseline of **0**.

## How it is produced

Two steps, both reproducible:

1. **`scripts/build-sample-solution.ps1`** drives TwinCAT XAE's automation interface once to create the
   `.sln`, `.tsproj` and an empty `.plcproj`. Only TwinCAT can write those correctly — the template on
   disk is a 67-byte stub that TwinCAT expands at insertion time, and hand-writing them produced a
   project XAE refused to open. Requires TwinCAT; run rarely.
2. **`scripts/build-sample-project.js`** writes the 19 PLC objects and *injects* their `<Compile>` and
   `<Folder>` entries into XAE's `.plcproj`, leaving its identity GUIDs, library references and
   options archive untouched. Deterministic and idempotent — no TwinCAT needed.

## What is and is not committed

Committed: the solution/system/PLC project files, the 19 objects, XAE's `PlcTask.TcTTO`, `_Config/`.

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
