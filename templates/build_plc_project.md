# `build_plc_project` — argument reference

Headless TwinCAT 3 build. There is no unit-test framework for Structured Text, so **a full compile is
the test**: treat a green build as the ground truth after any change to a `.Tc*` file or a `.plcproj`.
A clean grep proves nothing; a successful build proves the project still compiles and resolves.

The same help is in the script itself — `Get-Help .\build_plc_project.ps1 -Full`.

| | |
|---|---|
| `build_plc_project.ps1` | the builder — call this from a shell, automation or CI |
| `build_plc_project.bat` | double-click wrapper; forwards `%*`, prints `BUILD OK` / `BUILD FAILED`, pauses |

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_plc_project.ps1 [[-SlnPath] <String>]
                                                                           [-TcVersion <String>]
                                                                           [-AllowVersionMismatch]
```

## Arguments

All three are optional. Only `-SlnPath` is positional; the other two must be named.

| Argument | Position | Default | Purpose |
|---|---|---|---|
| `-SlnPath`, `-Solution` | **0** (first) | the single `.sln` under the repo root | which solution to build |
| `-TcVersion` | named | read from the solution's `.tsproj` | which TwinCAT to build with — shell *and* pinned version |
| `-AllowVersionMismatch` | named (switch) | off | build anyway when `-TcVersion`'s build number disagrees with the project |

> **`-ProgId` was removed** (2026-07-29). It was a second, independent version knob that could
> contradict `-TcVersion`, and a contradiction produced a **green build against the wrong TwinCAT**.
> `-TcVersion` now accepts a ProgId directly. Passing `-ProgId` is a PowerShell parameter error.

### `-SlnPath` (alias `-Solution`) — which solution

Positional, so `build_plc_project.bat MyProject` works. Forgiving about what you name it — all of
these resolve to the same solution:

| You type | Interpreted as |
|---|---|
| `MyProject` | bare name; `MyProject.sln` found anywhere under the repo root |
| `MyProject.sln` | the same, with the extension |
| `MyProject\MyProject.sln` | path, relative to the current directory or the repo root |
| `C:\Projects\MyRepo\MyProject` | a directory holding exactly one `.sln` |
| `C:\Projects\MyRepo\MyProject\MyProject.sln` | full path |

**Resolution order is most-specific first**, and it stops at the first hit:

1. an existing `.sln` **file** — as given, or relative to the repo root;
2. a **directory** containing exactly one `.sln`;
3. a repo-wide hunt for `<name>.sln`.

That ordering is deliberate: naming something precisely can never be reinterpreted as something
vaguer. **Ambiguity at any stage is an error listing the candidates — never a silent pick.**

**Omit it** and the repo root is searched *recursively*. The repo root is the nearest enclosing **`.git`
directory**, walked up from the script — *not* a fixed level above it — so the scripts keep working
wherever they are nested (`<Repo>\Scripts\`, `<Repo>\Scripts\Build project\`, …). Outside a git repo it
falls back to the script's parent directory. Exactly one `.sln` is used; two or more are refused, which
is the normal state as soon as a sandbox clone sits beside the project:

```
FATAL: 2 .sln files under the repo root - name the one you want:
  MyProject                C:\Projects\MyRepo\MyProject\MyProject.sln
  MyProject_sandbox        C:\Projects\MyRepo\MyProject_sandbox\MyProject_sandbox.sln
e.g.  build_plc_project.bat MyProject
```

The project's TwinCAT version is then read from the first `.tsproj` under **the resolved solution's
own directory**, never repo-wide — so a sandbox can never supply the version used to build another
project. It is read on *every* run, not only when `-TcVersion` is omitted, because it is what
`-TcVersion` is validated against.

### `-TcVersion` — which TwinCAT to build with

> **Passing `-TcVersion` is what turns pinning on.** Omit it and the script picks the right *shell*
> from the project's build number and then leaves the shell's configured TwinCAT version alone —
> nothing is pinned, because you did not ask for a particular version. Pass it and that exact version
> is pinned via `TcRemoteManager` and confirmed. Naming a version means "build with this"; saying
> nothing means "build this project".

Building with the wrong TwinCAT *fails, or silently upgrades the project*. Two things decide it and
both must agree with the project's saved `TcVersion`: the **XAE Shell** that is launched, and the
**TwinCAT system version pinned** for that shell session via `TcRemoteManager` (the 4026 shell is
multi-version, so the 32-bit 4024 shell will happily bind 4026 libraries if the session version is
left alone). `-TcVersion` is the single knob for both — it takes either form and derives the other:

| You pass | Effective build | Effective revision | Shell | Pinned? |
|---|---|---|---|---|
| *(nothing)* | the project's | — | from the project's build | **no** — shell default is used |
| `3.1.4026.22` | `4026` | `.22` | `TcXaeShell.DTE.17.0` | yes, confirmed |
| `TcXaeShell.DTE.17.0` | `4026` | the project's | `TcXaeShell.DTE.17.0` | yes, confirmed |

A ProgId names a build *family*, not a revision, so it inherits the project's revision.

| TwinCAT build | XAE Shell | ProgId |
|---|---|---|
| `3.1.4024.x` | XAE Shell (VS2017 isolated, 32-bit) | `TcXaeShell.DTE.15.0` |
| `3.1.4026.x` | XAE Shell 64 (VS2022 isolated, 64-bit) | `TcXaeShell.DTE.17.0` |

The shell must be registered or the script exits `2` rather than building with the wrong one. An
unknown build number (neither 4024 nor 4026) also exits `2` — teach it a new one by adding a row to
the `$ProgIdByBuild` table in the script.

#### Validation

The result is compared with the project's `.tsproj` **before any COM object is created**, so the
common mismatch fails in about a second with no IDE launched:

| Condition | Result |
|---|---|
| build differs — `4024` vs `4026` | **fatal, exit `2`** — unless `-AllowVersionMismatch` |
| revision differs — `.17` vs `.22` | warning; the build proceeds |
| `-TcVersion` is neither a version nor a known ProgId | **fatal**, even with `-AllowVersionMismatch` |
| the build has no XAE Shell mapping | **fatal**, even with `-AllowVersionMismatch` |

```
Solution: C:\Projects\MyRepo\MyProject\MyProject.sln
Project TwinCAT version: 3.1.4026.22  (from MyProject.tsproj)
Requested:               3.1.4024.62  ->  TcXaeShell.DTE.15.0
FATAL: TwinCAT build 4024 does not match the project's 4026 (3.1.4024.62 vs 3.1.4026.22).
       Pass -AllowVersionMismatch to build anyway.
```

Revision drift stays permissible because the pin has a designed fallback: if the exact revision is
not installed, the newest installed version sharing that build number is used and reported. Making it
fatal would turn that fallback into a failure on any machine lacking the exact revision.

If **no** version of that build is installed the pin is unsatisfiable, and that is **fatal (exit 2)**
— it used to be a swallowed warning, which meant the build silently ran on whatever version the shell
was configured for. If the installed-version list cannot be read at all, the check is announced as
skipped rather than passing silently:

```
WARNING: could not read the installed TwinCAT version list from TcRemoteManager: <error>
WARNING: installed-version check SKIPPED - pinning 3.1.4026.22 without confirming it is installed.
```

**Pinning runs on both shells.** It was previously skipped on 4024, on the belief that 4024 is a
single-version install exposing no `TcRemoteManager` version list. That is false — measured
2026-07-29, the 4024 shell lists **six** versions where the 4026 shell lists four:

| Queried from | `TcRemoteManager.Versions` |
|---|---|
| `TcXaeShell.DTE.17.0` (4026) | `3.1.4026.22, .20, .19, .17` |
| `TcXaeShell.DTE.15.0` (4024) | `3.1.4026.22, .20, .19, .17, 3.1.4024.62, 3.1.4024.50` |

The 4024 versions are visible **only** from the 4024 shell. That asymmetry is why the list is read from
the shell chosen for the *requested* version rather than a fixed one — asking the 4026 shell about
`3.1.4024.62` reports it missing when it is installed, which is exactly what the old code did.

The pin is then **confirmed** by reading `rm.Version` back rather than assumed. A shell that declines
the pin would otherwise print `Pinned` and build on the old version — the silent wrong-version failure
this page exists to prevent. Three outcomes:

| Readback | Meaning | Result |
|---|---|---|
| equals the requested version | switch took | `Pinned … (confirmed)` |
| a *different* non-empty version | shell refused | **fatal** — `TcRemoteManager did not honour the pin` |
| stays empty | pin equals the shell's default | `Pinned … (shell reports its default; assumed equal)` |

When the shell is already on the requested version nothing is set and nothing is waited for, so the
common path costs nothing. `Solution.Open` is retried after a pin, because a reloaded environment can
reject it with `STG_E_FILENOTFOUND` until it settles.

### `-AllowVersionMismatch` — build it anyway

Downgrades the build-number mismatch, and an unsatisfiable pin, from fatal to a warning. It does
**not** excuse an unparseable `-TcVersion` or a build with no shell mapping: there is no usable
version behind either, so there is nothing to authorise.

Expect the project to be silently upgraded, or the build to fail. **Run it against a sandbox clone,
never the project you actually ship.**

### Testing the version logic

`test-resolve-twincat-target.ps1` unit-tests `Resolve-TwinCatTarget`, the COM-free function
that makes this decision. It lifts the function out of `build_plc_project.ps1` with the PowerShell
parser (dot-sourcing the builder would *build*), needs no TwinCAT installation, and launches no IDE:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-resolve-twincat-target.ps1
```

## Exit codes

**The exit code is the pass/fail signal.** Gate scripts and CI on it, not on the console text.

| Code | Meaning |
|---|---|
| `0` | build succeeded |
| `1` | build failed — real compile errors |
| `2` | harness/COM error: shell not installed, solution not found or ambiguous, solution would not open, configuration not found, TwinCAT version mismatch, unsatisfiable version pin |

Inside the script `LastBuildInfo` (the count of failed projects) is what decides pass/fail. The error
list it prints is best-effort and is **often empty over late-bound COM even on a genuine failure**, so
a failed build can show exit `1` with no itemised errors; the script then also dumps the IDE's
output-window panes. Open the solution in the IDE if you need more detail.

## Examples

```powershell
# The only solution under the repo root.
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_plc_project.ps1

# By name. Double-click wrapper, pauses at the end.
.\build_plc_project.bat MyProject

# By name, from PowerShell.
.\build_plc_project.ps1 MyProject

# Named form, plus an explicit version instead of reading the .tsproj. It must match the
# project's build number, or the run exits 2 before the IDE starts.
.\build_plc_project.ps1 -Solution MyProject -TcVersion 3.1.4026.22

# Name the shell instead of the version; the revision still comes from the .tsproj.
.\build_plc_project.ps1 MyProject -TcVersion TcXaeShell.DTE.17.0

# Deliberately build a 4026 project with 4024 - a sandbox clone, never the real project.
.\build_plc_project.ps1 MyProject_sandbox -TcVersion 3.1.4024.62 -AllowVersionMismatch

# Gate on the result.
.\build_plc_project.ps1 MyProject
if ($LASTEXITCODE -ne 0) { throw "build failed with $LASTEXITCODE" }
```

## Not arguments

Things that look like they should be parameters and are not:

- **`-ProgId`** — removed on 2026-07-29, folded into `-TcVersion`, which now accepts a ProgId. Passing
  it is a PowerShell parameter error. It existed as a second version knob that could disagree with
  `-TcVersion`; that disagreement is precisely how a build against the wrong TwinCAT reported success.
- **`-PinVersion`** — does not exist *here*. Its job was folded into `-TcVersion`: passing a version
  is what turns pinning on, omitting it leaves the shell's configured version alone. Copies of this
  script deployed before 2026-07-29 still take `-PinVersion`; on one of those, `-TcVersion` picks the
  shell but pins nothing.
- **`-STA`** — not a script parameter; it is a `powershell.exe` switch (some `.bat` wrappers pass it
  explicitly, and it is harmless either way). The apartment state still matters. Routine COM rejections
  are ridden out by an internal retry helper; a **version switch** additionally needs an
  `IOleMessageFilter`, which is registered only when the thread is STA and only when a pin is requested.
  Setting `rm.Version` reloads the shell environment and floods `RPC_E_CALL_REJECTED`, and the retry
  helper cannot cover that — it retries calls *this script* makes, not the DTE's own in-flight traffic.
  `powershell.exe` and `pwsh` both run `-File` in STA already, so this is normally automatic; under MTA
  the script warns and continues, since only pinning is affected.
- **Build configuration** — hardcoded to `Release` | `TwinCAT RT (x64)` in `$ConfigName` /
  `$PlatformName` near the top of the script. A solution naming its configuration or platform
  differently reports "configuration not found" and exits `2`; edit those two variables.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no .sln found anywhere under repo root` | run from a different tree, or the solution really is absent |
| `N .sln files under the repo root` | a sandbox clone exists — name the one you want (the message lists them) |
| `cannot resolve '<x>' to a solution` | the name matched nothing as a file, a directory, or `<x>.sln` |
| `'<x>' matches N solutions` | two sandboxes share a name — pass a path instead |
| `DTE ProgId '<x>' is not registered` | the XAE Shell matching the project's TwinCAT build is not installed |
| `TwinCAT build <a> does not match the project's <b>` | `-TcVersion` names a different build family than the `.tsproj` — fix the argument, or pass `-AllowVersionMismatch` if you mean it |
| `cannot interpret -TcVersion '<x>'` | it is neither `3.1.<build>.<rev>` nor a known DTE ProgId; `-AllowVersionMismatch` does not help |
| `no XAE Shell mapping for TwinCAT build 3.1.<b>` | add a row to `$ProgIdByBuild` in the script |
| `no installed TwinCAT <b>.x version` | nothing of that build is installed, so the pin cannot be honoured — install it, or `-AllowVersionMismatch` to run on the shell's default |
| `installed-version check SKIPPED` | `TcRemoteManager` would not list versions; the pin was applied unverified |
| `A parameter cannot be found that matches parameter name 'ProgId'` | `-ProgId` was removed — pass the ProgId to `-TcVersion` instead |
| `Configuration 'Release\|TwinCAT RT (x64)' not found` | the solution names its configuration differently — see *Not arguments* |
| exit `1`, no errors listed | expected over late-bound COM; read the output-window dump, or open the solution in the IDE |

## See also

- the project's **`CLAUDE.md`** — TwinCAT file formats, the rule that edits preserve every byte outside
  the CDATA blocks, and why a green build is the only real test here
