# Changelog

## 0.11.0 (2026-11-16)

The first release as **TC Toolkit** (formerly "TwinCAT XML Viewer" / "TwinCAT PLC Toolkit"). Changes since 0.10.1:

### New
- **TC Toolkit sidebar and Start Page**: create a new TwinCAT 3 project (3.1.4024 or 3.1.4026), open a recent one, and run project actions from one place.
- **Build Project**: checks a PLC project with the bundled IEC 61131-3 compiler, fully offline. Problems appear in the Problems panel and as squiggles in the panes; conditional pragmas and the `.plcproj` compiler defines are honoured. Optionally writes the project as C++ and compiles it with g++.
- **Build and Activate through XAE** (Windows with TwinCAT XAE): builds with XAE's own compiler and activates the configuration on a runtime of this PC you pick and confirm. It offers to change a solution's stale target, recognises the 3.1.4026 user-mode runtime's current AMS Net ID, and installs the PLC program as a boot project with autostart, so the PLC runs right after activation.
- **Online monitoring over ADS**: live values next to the code, a **PLC Watch** view (its own tab in the bottom panel, or in the sidebar), confirmed one-off writes, and **Start / Stop PLC**, confirmed each time. A code check blocks writes when the PLC runs a different build.
- **TwinCAT 3.1.4026 user-mode runtime**: when its router refuses the connection, Go Online switches to TwinCAT's own ADS DLL by itself, and *Local runtime* finds the user-mode runtime's AMS Net ID.
- **Language server**: diagnostics respect `{IF}` pragmas; pragma hover, rename, nested comments; faster indexing; library declarations for the compiler.
- **Buttons where you work**: Build, Build and Activate, Go Online / Offline and Show Activation Targets on the editor tab, the PLC Objects header and the Start Page.
- **Settings for the ADS DLL locations** (`tcToolkit.adsDll.*`), for machines where TwinCAT is installed elsewhere; a missing DLL's message offers *Open Setting*.

### Changed
- **New look**: a slim editor header that follows your VS Code theme (path, type tag, status, a one-click Build button and an **Actions** menu for everything else), a matching Start Page, and a new TC logo.
- **Settings keys are now `tcToolkit.*`**; existing values are moved over once, automatically.
- **The bundled compiler is at fork release N**: TIME, DATE, TOD and DT are 4 bytes as on the PLC; division by zero, a bad index or a NULL dereference are run-time faults naming the POU and line; a plain STRING is 80 characters under the TwinCAT profile.
- **Licence**: AGPL-3.0-or-later.

### Fixed
- PLC Watch values update steadily, without the flashing progress bar.
- Writes are no longer blocked as "edited since the last build" after a body-only change was built.
- *Show Problems* on a build summary opens the Problems panel directly.
- Generate ST writes each project's files into its own `ST_Files` folder and works in multi-project workspaces.

### Known issues
- The compiler accepts a few forms that the generated C++ does not build (g++ reports them); see the README's "Known limitations".
- Online monitoring's user-mode fallback, Build through XAE and Build and Activate are Windows-only.

## 0.10.1
- Structures that EXTEND a structure from the project's own DUTs are resolved.
