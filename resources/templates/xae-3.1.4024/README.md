# XAE 3.1.4024 skeleton (R2 input)

An empty solution written by TwinCAT XAE 3.1.4024.62 on the maintainer's machine, 2026-11-09:
a standard PLC project with `MAIN`, the `PlcTask` that calls it and one GVL. Stored unchanged
except that the `.vs/` folder, the `.bak` file and `_Boot/` were left out, and so was `_Libraries/`.
XAE's template adds three vendor libraries by default (`Tc2_Standard`, `Tc2_System`, `Tc3_Module`). Their
references stay in the `.plcproj` as `PlaceholderReference` entries. `_Libraries/` is only XAE's local copy of the
library binaries: it is not ours to redistribute (`sample/` does not commit it either), and XAE fills it in again
when the project is opened.

This is the source R2 ("create a new TwinCAT project") turns into its 3.1.4024 template — see
ROADMAP.md, R2. Do not hand-edit it: R2's template is derived from it, and must be proven to open
and build in XAE 3.1.4024 before it ships.

Note for R2: this XAE saved the system project as one `.tspproj` file, where the 3.1.4026 solution
under `sample/` has a `.tsproj` plus a `_Config/` folder. The GVL carries a sample variable and
`{attribute 'qualified_only'}`; the template's GVL is to be emptied.
