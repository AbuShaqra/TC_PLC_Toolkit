<#
.SYNOPSIS
    TwinCAT 3 headless build, driven through the Automation Interface (DTE COM).

.DESCRIPTION
    Builds a TwinCAT solution without opening the IDE by hand, and reports pass/fail as an exit code.
    There is no unit-test framework for Structured Text, so a full compile IS the test: treat a green
    build as the ground truth after any change to a `.Tc*` file or a `.plcproj`.

    The devenv-style CLI of the XAE Shell crashes on startup ("SyncLock called without an initialized
    synchronization object"), so this script builds through the COM Automation Interface instead, which
    is Beckhoff's documented approach for automated builds.

    Building with the wrong TwinCAT version fails, or silently upgrades the project. That has TWO
    independent knobs, and both must match the version the project was saved with (its `.tsproj`
    TcVersion):

      1. the XAE Shell (DTE ProgId) that is launched, and
      2. the TwinCAT system version pinned for that shell session via TcRemoteManager.

    The 32-bit 4024 shell can still bind 4026 libraries if the session version is not pinned, so both
    are set automatically from the `.tsproj`. -TcVersion is the single override for both: it takes
    either a version or a DTE ProgId and derives the other, so the two knobs cannot disagree.

    Whatever it resolves to is checked against the `.tsproj` BEFORE any COM object is created, so a
    build-number mismatch fails in about a second with no IDE launched. That check is fatal (exit 2)
    unless -AllowVersionMismatch is passed.

    Build number -> shell, as mapped by the $ProgIdByBuild table in this script:

        3.1.4024.x   XAE Shell    (VS2017 isolated, 32-bit)   TcXaeShell.DTE.15.0
        3.1.4026.x   XAE Shell 64 (VS2022 isolated, 64-bit)   TcXaeShell.DTE.17.0

    Version pinning runs on BOTH shells. It used to be skipped on 4024, on the belief that 4024 is a
    single-version install with no TcRemoteManager version list. Measured false on 2026-07-29: the 4024
    shell lists six versions - 3.1.4026.22/.20/.19/.17 plus 3.1.4024.62/.50 - where the 4026 shell lists
    only its own four. The 4024 versions are visible ONLY from the 4024 shell, which is why the list
    must be read from the shell chosen for the requested version rather than a fixed one.

    The pin is confirmed by reading rm.Version back, not assumed: a pin the shell declines to honour
    would otherwise print "Pinned" and build on the old version.

.PARAMETER SlnPath
    The solution to build. Positional (first argument) and also spelled -Solution, so
    `build_plc_project.bat MyProject` works.

    Forgiving about what you name it. All of these resolve to the same solution:

        MyProject                                    bare name, found anywhere under the repo root
        MyProject.sln                                the same, with the extension
        MyProject\MyProject.sln                      path relative to the CWD or to the repo root
        C:\Projects\MyRepo\MyProject                 a directory holding exactly one .sln
        C:\Projects\MyRepo\MyProject\MyProject.sln   full path

    Resolution is most-specific first - an existing .sln file, then a directory holding exactly one,
    then a repo-wide '<name>.sln' hunt - so naming something precisely is never reinterpreted as
    something vaguer. Anything ambiguous is an error listing the candidates, never a silent pick.

    Omit it and the repo root is searched RECURSIVELY. Exactly one .sln is used; two or more are
    refused with the candidates listed, which is the normal state as soon as a sandbox clone of the
    project sits beside it.

.PARAMETER TcVersion
    Which TwinCAT to build with - the only version knob there is, and the switch that enables pinning.

    PASSING IT PINS. The version is set via TcRemoteManager and confirmed before the solution opens.
    OMITTING IT DOES NOT. The correct SHELL is still chosen from the project's build number, but the
    shell's configured TwinCAT version is left exactly as it is. Naming a version means "build with
    this"; saying nothing means "build this project", and overriding the version on top of that would
    assert something the caller never said.

    Accepts either form and derives the other, so the shell and the pinned version cannot disagree:

        3.1.4026.22           a system version; the shell follows from its build number (4026)
        TcXaeShell.DTE.17.0   a DTE ProgId; names a build FAMILY, so the revision stays the project's

    Omit it and both are read from the solution's `.tsproj`. The ProgId must be registered or the
    script exits 2 rather than building with a shell that does not match the project.

    The result is validated against the project's saved version before the IDE is launched:

        build differs    (4024 vs 4026)                   FATAL, exit 2 - see -AllowVersionMismatch
        revision differs (.17 vs .22)                     warning; the build proceeds
        unparseable, or a build with no shell mapping     FATAL, always

    If the exact revision is not installed, the newest installed version sharing the same build number
    is used and reported. If NO version of that build is installed the pin is unsatisfiable, which is
    fatal (exit 2) rather than a warning: the build would otherwise silently run on whatever version
    the shell happened to be configured for.

    There is no -ProgId parameter - it was removed. Two knobs that could disagree are how a build
    against the wrong TwinCAT used to report success.

.PARAMETER AllowVersionMismatch
    Build anyway when the effective TwinCAT build number does not match the project's, downgrading
    that fatal error to a warning. Also downgrades an unsatisfiable version pin.

    It does NOT excuse an unparseable -TcVersion or a build with no XAE Shell mapping: there is no
    usable version behind either, so there is nothing for the switch to authorise. Expect the project
    to be silently upgraded, or the build to fail - run it against a sandbox clone, never the project
    you actually ship.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\build_plc_project.ps1

    Build the only solution under the repo root.

.EXAMPLE
    .\build_plc_project.bat MyProject

    Build a solution by name - the double-click wrapper, which pauses so the window stays open.

.EXAMPLE
    .\build_plc_project.ps1 -Solution MyProject -TcVersion 3.1.4026.22

    Build MyProject, stating the TwinCAT version explicitly instead of reading it from the .tsproj.
    It must match the project's build number, or the run exits 2.

.EXAMPLE
    .\build_plc_project.ps1 MyProject -TcVersion TcXaeShell.DTE.17.0

    Name the XAE Shell instead of the version. The revision still comes from the .tsproj.

.EXAMPLE
    .\build_plc_project.ps1 MyProject_sandbox -TcVersion 3.1.4024.62 -AllowVersionMismatch

    Deliberately build a 4026 project with 4024. Without the switch this exits 2 before the IDE is
    launched; with it, the mismatch is only a warning.

.EXAMPLE
    .\build_plc_project.ps1 MyProject; if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Gate on the exit code, which is the authoritative pass/fail signal.

.NOTES
    EXIT CODES - gate scripts and CI on these, not on the console text:
        0   build succeeded
        1   build failed (real compile errors)
        2   harness/COM error: shell not installed, solution not found or ambiguous, solution would
            not open, configuration not found, TwinCAT version mismatch or unsatisfiable version pin

    On failure the IDE's error list is usually empty over late-bound COM, so the script also dumps the
    output-window panes. LastBuildInfo (the count of failed projects) is what decides pass/fail.

    NOT a parameter here: there is no -PinVersion switch. Pinning is driven by -TcVersion and runs on
    either shell. Copies of this script deployed before 2026-07-29 gate pinning behind -PinVersion
    instead - on one of those, -TcVersion selects the shell but pins nothing.

    STA: an IOleMessageFilter is registered when the thread is STA, and it is REQUIRED for a version
    switch to survive - setting rm.Version reloads the shell environment and floods
    RPC_E_CALL_REJECTED, and Invoke-ComRetry cannot help there because it only retries calls this
    script makes, not the DTE's own in-flight traffic. powershell.exe and pwsh both run -File in STA,
    so this is normally automatic. Under MTA the script warns and continues: everything except a
    version switch is unaffected.
    -ProgId is gone as of 2026-07-29 - -TcVersion absorbed it, and passing -ProgId is now a PowerShell
    parameter error. The build configuration is hardcoded to 'Release' | 'TwinCAT RT (x64)' in
    $ConfigName / $PlatformName near the top of this script.

    Resolve-TwinCatTarget below is deliberately COM-free and is the one part of the version logic
    testable without a TwinCAT installation - see test-resolve-twincat-target.ps1, beside this script.

.LINK
    build_plc_project.md
#>

param(
    # See .PARAMETER SlnPath above - `Get-Help .\build_plc_project.ps1 -Full`.
    [Parameter(Position = 0)]
    [Alias('Solution')]
    [string]$SlnPath,
    # See .PARAMETER TcVersion above: a version OR a DTE ProgId; the other is derived from it.
    [string]$TcVersion,
    [switch]$AllowVersionMismatch
)

# Whether the CALLER named a version, captured before $TcVersion is filled in from the .tsproj below.
# This is the pin switch: naming a version means "build with exactly this", so it is pinned and
# confirmed. Saying nothing means "build this project" - the shell is still chosen from the project's
# build number, but its configured default version is left alone rather than being overridden with a
# value the caller never asked for.
$PinRequested = $PSBoundParameters.ContainsKey('TcVersion')

# Repo root, resolved by walking UP to the enclosing git repository rather than assuming a fixed depth.
#
# This script is copied between projects that nest it differently - `<repo>\Scripts\` in some,
# `<repo>\Scripts\Build project\` in others - and a hardcoded `Split-Path -Parent $PSScriptRoot` silently
# resolves to the wrong directory the moment it is moved, reporting "no .sln found" while the solution
# sits one level further up. Anchoring on .git makes the same file correct in every layout.
function Resolve-RepoRoot {
    param([Parameter(Mandatory)][string]$From)
    $dir = $From
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $dir }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    # Not in a git repo: fall back to the historical assumption, one level above the script.
    return (Split-Path -Parent $From)
}
$RepoRoot     = Resolve-RepoRoot -From $PSScriptRoot

# TwinCAT build number -> XAE Shell DTE ProgId.
#   4024 = XAE Shell (VS2017 isolated shell, 32-bit)  -> C:\Program Files (x86)\Beckhoff\TcXaeShell
#   4026 = XAE Shell 64 (VS2022 isolated shell, 64-bit) -> C:\Program Files\Beckhoff\TcXaeShell
$ProgIdByBuild = @{
    '4024' = 'TcXaeShell.DTE.15.0'
    '4026' = 'TcXaeShell.DTE.17.0'
}

# Turns whatever the caller named into an absolute .sln path, or throws saying what it tried.
# Deliberately ordered most-specific first: an explicit file wins over a directory, and a directory
# over a repo-wide name hunt, so naming something precisely can never be reinterpreted as something
# vaguer. Ambiguity is always an error - never a silent pick.
function Resolve-SolutionPath {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Root
    )

    # 1. An actual .sln file - as given (absolute, or relative to the CWD), or relative to the repo
    #    root. Join-Path with an absolute $Value yields a nonsense path that simply fails Test-Path.
    foreach ($candidate in @($Value, (Join-Path $Root $Value))) {
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and
            ([System.IO.Path]::GetExtension($candidate) -eq '.sln')) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    # 2. A directory holding exactly one .sln - "build the MyProject project".
    foreach ($dir in @($Value, (Join-Path $Root $Value))) {
        if (Test-Path -LiteralPath $dir -PathType Container) {
            $hits = @(Get-ChildItem -LiteralPath $dir -Filter *.sln -File | Sort-Object FullName)
            if ($hits.Count -eq 1) { return $hits[0].FullName }
            if ($hits.Count -gt 1) {
                throw ("directory '$dir' holds $($hits.Count) .sln files - name one:`n" +
                       (($hits | ForEach-Object { "  $($_.FullName)" }) -join "`n"))
            }
        }
    }

    # 3. A bare solution name, matched anywhere under the repo root. Accepts it with or without the
    #    .sln suffix, so `-Solution MyProject` and `-Solution MyProject.sln` behave the same.
    $leaf = [System.IO.Path]::GetFileNameWithoutExtension($Value)
    $hits = @(Get-ChildItem -Path $Root -Recurse -Filter "$leaf.sln" -File -ErrorAction SilentlyContinue |
              Sort-Object FullName)
    if ($hits.Count -eq 1) { return $hits[0].FullName }
    if ($hits.Count -gt 1) {
        throw ("'$Value' matches $($hits.Count) solutions - pass a path instead:`n" +
               (($hits | ForEach-Object { "  $($_.FullName)" }) -join "`n"))
    }

    throw ("cannot resolve '$Value' to a solution. Tried it as a .sln path, as a directory holding " +
           "one, and as '<name>.sln' anywhere under $Root.")
}

# Decides which TwinCAT to build with, and refuses to decide something that contradicts the project.
#
# Pure by design - no COM, no registry, no filesystem - for two reasons: it can run BEFORE the IDE is
# launched, so the common mismatch costs a second instead of a shell startup, and it is the only part
# of the version logic testable without a TwinCAT installation (test-resolve-twincat-target.ps1).
#
#   -Requested   what the caller passed to -TcVersion: a version, a DTE ProgId, or nothing
#   -Returns     ProjectVersion, EffectiveVersion, Build, ProgId, Warnings (string[])
#
# Throws on anything it cannot honour; the message names the candidates, like Resolve-SolutionPath.
function Resolve-TwinCatTarget {
    param(
        [string]$Requested,
        [Parameter(Mandatory)][string]$ProjectVersion,
        [Parameter(Mandatory)][hashtable]$ProgIdByBuild,
        [switch]$AllowMismatch
    )

    $warnings = @()
    $knownProgIds = @($ProgIdByBuild.Keys | Sort-Object | ForEach-Object { $ProgIdByBuild[$_] })

    if ($ProjectVersion -notmatch '^3\.1\.(\d+)\.(\d+)$') {
        throw "the project's TwinCAT version '$ProjectVersion' is not of the form 3.1.<build>.<revision>."
    }
    $projectBuild = $Matches[1]
    $projectRev   = $Matches[2]

    # Nothing requested: the project's own version, unconditionally. This is the normal path.
    $build     = $projectBuild
    $effective = $ProjectVersion

    if ($Requested) {
        if ($Requested -match '^3\.1\.(\d+)\.\d+$') {
            $build     = $Matches[1]
            $effective = $Requested
        }
        else {
            # A ProgId, matched against the VALUES of the map rather than a regex, so only ProgIds
            # this script can actually map are accepted. A ProgId names a build family and says
            # nothing about a revision, so the project's revision is inherited.
            $key = $null
            foreach ($k in $ProgIdByBuild.Keys) {
                if ([string]$ProgIdByBuild[$k] -ieq $Requested) { $key = $k; break }
            }
            if (-not $key) {
                throw ("cannot interpret -TcVersion '$Requested'. Pass a version like 3.1.4026.22, " +
                       "or one of these DTE ProgIds: $($knownProgIds -join ', ').")
            }
            $build     = $key
            $effective = "3.1.$build.$projectRev"
        }

        if ($build -ne $projectBuild) {
            # The failure this whole function exists for: a wrong-build build either fails or
            # silently upgrades the project, and used to exit 0 either way.
            $msg = ("TwinCAT build $build does not match the project's $projectBuild " +
                    "($effective vs $ProjectVersion).")
            if (-not $AllowMismatch) {
                throw ($msg + "`n       Pass -AllowVersionMismatch to build anyway.")
            }
            $warnings += ($msg + " Building anyway (-AllowVersionMismatch).")
        }
        elseif ($effective -ne $ProjectVersion) {
            # Same build family, different revision. A warning, not an error: the pinning step
            # falls back to the nearest same-build version by design, and making this fatal would
            # turn that designed behaviour into a failure on any machine lacking the exact revision.
            $warnings += ("TwinCAT revision $effective differs from the project's $ProjectVersion " +
                          "(same build $build).")
        }
    }

    # Fatal even under -AllowMismatch: with no mapping there is no shell to launch at all, so there
    # is nothing for the override to authorise.
    if (-not $ProgIdByBuild.ContainsKey($build)) {
        throw ("no XAE Shell mapping for TwinCAT build 3.1.$build. Known builds: " +
               "$(($ProgIdByBuild.Keys | Sort-Object) -join ', ') - teach it a new one by adding a " +
               "row to the `$ProgIdByBuild table in this script.")
    }

    return [pscustomobject]@{
        ProjectVersion   = $ProjectVersion
        EffectiveVersion = $effective
        Build            = $build
        ProgId           = $ProgIdByBuild[$build]
        Warnings         = [string[]]$warnings
    }
}

if ($SlnPath) {
    try {
        $SlnPath = Resolve-SolutionPath -Value $SlnPath -Root $RepoRoot
    } catch {
        Write-Host "FATAL: $_" -ForegroundColor Red
        exit 2
    }
}

if (-not $SlnPath) {
    # RECURSIVE by design: the solution does not have to sit in the repo root. Projects commonly
    # keep it one level down (<Repo>\MyProject\MyProject.sln), and sandbox clones land in further
    # siblings - a top-level-only search finds neither.
    #
    # More than one .sln is therefore an expected state (the moment a sandbox is cloned), not a
    # broken repo: it is still refused, because picking one for you is how you end up building
    # something other than what you meant, but the message lists the candidates so -SlnPath is a
    # copy-paste away.
    $slns = @(Get-ChildItem -Path $RepoRoot -Recurse -Filter *.sln -File -ErrorAction SilentlyContinue |
              Sort-Object FullName)
    if ($slns.Count -eq 0) {
        Write-Host "FATAL: no .sln found anywhere under repo root: $RepoRoot" -ForegroundColor Red
        exit 2
    }
    if ($slns.Count -gt 1) {
        Write-Host "FATAL: $($slns.Count) .sln files under the repo root - name the one you want:" -ForegroundColor Red
        $slns | ForEach-Object {
            Write-Host ("  {0,-24} {1}" -f [System.IO.Path]::GetFileNameWithoutExtension($_.Name), $_.FullName)
        }
        Write-Host ("e.g.  build_plc_project.bat {0}" -f
            [System.IO.Path]::GetFileNameWithoutExtension($slns[0].Name)) -ForegroundColor Yellow
        exit 2
    }
    $SlnPath = $slns[0].FullName
}
Write-Host "Solution: $SlnPath" -ForegroundColor Cyan

$ConfigName   = "Release"
$PlatformName = "TwinCAT RT (x64)"

# The project's saved TwinCAT version is read ALWAYS, never only when -TcVersion is absent: it is
# what -TcVersion is validated against, so there is no run in which it is optional.
#
# Scoped to the SOLUTION's own directory, never the repo root: with sandbox clones around, a
# repo-wide search sorted by name would happily read the version out of a different project and
# then build this one with it.
$slnDir = Split-Path -Parent $SlnPath
$tsproj = Get-ChildItem -Path $slnDir -Recurse -Filter *.tsproj -File -ErrorAction SilentlyContinue |
          Sort-Object FullName | Select-Object -First 1
if (-not $tsproj) {
    Write-Host "FATAL: no .tsproj found under $slnDir to read TcVersion from." -ForegroundColor Red
    Write-Host "It is the only thing -TcVersion can be checked against, so it cannot be substituted." -ForegroundColor Red
    exit 2
}
$match = Select-String -Path $tsproj.FullName -Pattern 'TcVersion="(3\.1\.(\d+)\.\d+)"' | Select-Object -First 1
if (-not $match) {
    Write-Host "FATAL: could not read TcVersion from $($tsproj.Name)." -ForegroundColor Red
    Write-Host "It is the only thing -TcVersion can be checked against, so it cannot be substituted." -ForegroundColor Red
    exit 2
}
$ProjectTcVersion = $match.Matches[0].Groups[1].Value

# Resolve BEFORE any COM object exists, so a mismatch costs a second rather than an IDE startup.
try {
    $target = Resolve-TwinCatTarget -Requested $TcVersion -ProjectVersion $ProjectTcVersion `
                                    -ProgIdByBuild $ProgIdByBuild -AllowMismatch:$AllowVersionMismatch
}
catch {
    Write-Host ("Project TwinCAT version: {0}  (from {1})" -f $ProjectTcVersion, $tsproj.Name) -ForegroundColor Cyan
    if ($TcVersion) {
        # Display only. Re-resolving with the override on turns a pure mismatch into a success, so
        # the line can still name the shell the request would have selected; anything unparseable
        # or unmappable throws again and the raw string is shown instead.
        $shown = $null
        try {
            $shown = Resolve-TwinCatTarget -Requested $TcVersion -ProjectVersion $ProjectTcVersion `
                                           -ProgIdByBuild $ProgIdByBuild -AllowMismatch
        } catch { }
        if ($shown) {
            Write-Host ("Requested:               {0}  ->  {1}" -f $shown.EffectiveVersion, $shown.ProgId) -ForegroundColor Yellow
        } else {
            Write-Host ("Requested:               {0}" -f $TcVersion) -ForegroundColor Yellow
        }
    }
    Write-Host "FATAL: $_" -ForegroundColor Red
    exit 2
}

$ProgId    = $target.ProgId
$TcVersion = $target.EffectiveVersion

# Labelled and separable: the project's version and the version being built with are two different
# facts, and printing them as one line is what let a 4024 request masquerade as a 4026 build.
Write-Host ("Project TwinCAT version: {0}  (from {1})" -f $target.ProjectVersion, $tsproj.Name) -ForegroundColor Cyan
if ($PinRequested) {
    Write-Host ("Building with:           {0}  ->  {1}" -f $target.EffectiveVersion, $target.ProgId) -ForegroundColor Cyan
} else {
    # Do not claim a version we are not going to set. Without -TcVersion the shell keeps whatever it
    # is configured for, and only the shell itself is chosen from the project.
    Write-Host ("Shell:                   {0}  (from build {1})" -f $target.ProgId, $target.Build) -ForegroundColor Cyan
    Write-Host  "TwinCAT version:         not pinned - using the shell's configured default" -ForegroundColor DarkGray
}
foreach ($w in $target.Warnings) { Write-Host "WARNING: $w" -ForegroundColor Yellow }

# Guard against a mismatched/missing shell: building a project with the wrong
# XAE Shell version is exactly the failure this detection exists to prevent.
if (-not (Test-Path "Registry::HKEY_CLASSES_ROOT\$ProgId")) {
    Write-Host "FATAL: DTE ProgId '$ProgId' is not registered - the matching XAE Shell is not installed." -ForegroundColor Red
    exit 2
}

# Retry helper: the shell rejects COM calls (RPC_E_CALL_REJECTED) while busy/starting up
function Invoke-ComRetry {
    param([scriptblock]$Action, [int]$MaxTries = 60, [int]$DelaySec = 2)
    for ($try = 1; $try -le $MaxTries; $try++) {
        try { return (& $Action) }
        catch {
            if ($_.Exception.ToString() -match '80010001|RPC_E_CALL_REJECTED|80010100|RPC_E_SERVERCALL') {
                Start-Sleep -Seconds $DelaySec
            } else { throw }
        }
    }
    throw "COM call still rejected after $MaxTries tries."
}

# ----------------------------------------------------------------------------
# IOleMessageFilter - REQUIRED for version pinning, not an optimisation.
#
# Setting TcRemoteManager.Version reloads the XAE Shell environment and floods RPC_E_CALL_REJECTED
# while it does. Invoke-ComRetry alone is not enough: it can only retry calls WE make, and it cannot
# keep the DTE's own in-flight COM traffic alive across the reload. A registered message filter is
# what carries the connection through, and it is load-bearing for the 4024 pin in particular.
#
# Carried over unchanged from the -PinVersion version of this script, where it is proven. The
# constants are not arbitrary:
#   RetryRejectedCall  r == 2 is SERVERCALL_RETRYLATER - the callee is merely busy, so retry in
#                      250 ms, but give up after 180 s so a wedged shell cannot hang the build
#                      forever. Anything else is a genuine refusal and must cancel (-1). Inverting
#                      this is an infinite hang.
#   MessagePending     2 is PENDINGMSG_WAITDEFPROCESS - keep dispatching while we wait.
#   HandleInComingCall 0 is SERVERCALL_ISHANDLED - accept incoming calls.
#
# A message filter is per-thread and only meaningful in a single-threaded apartment. Both
# powershell.exe and pwsh run -File in STA on this machine, so this normally just works; if some
# host runs MTA we warn and continue rather than refusing, because everything except a version
# switch is unaffected.
$filterRegistered = $false
if ($PinRequested -and [System.Threading.Thread]::CurrentThread.GetApartmentState() -eq 'STA') {
    if (-not ('TcBuildMessageFilter' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TcBuildMessageFilter : IOleMessageFilter {
    [DllImport("Ole32.dll")] private static extern int CoRegisterMessageFilter(IOleMessageFilter n, out IOleMessageFilter o);
    public static void Register() { IOleMessageFilter o = null; CoRegisterMessageFilter(new TcBuildMessageFilter(), out o); }
    public static void Revoke()   { IOleMessageFilter o = null; CoRegisterMessageFilter(null, out o); }
    int IOleMessageFilter.HandleInComingCall(int a, IntPtr b, int c, IntPtr d) { return 0; }
    int IOleMessageFilter.RetryRejectedCall(IntPtr a, int t, int r) { if (r == 2 && t < 180000) return 250; return -1; }
    int IOleMessageFilter.MessagePending(IntPtr a, int b, int c) { return 2; }
}
[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IOleMessageFilter {
    [PreserveSig] int HandleInComingCall(int a, IntPtr b, int c, IntPtr d);
    [PreserveSig] int RetryRejectedCall(IntPtr a, int t, int r);
    [PreserveSig] int MessagePending(IntPtr a, int b, int c);
}
'@
    }
    [TcBuildMessageFilter]::Register()
    $filterRegistered = $true
} elseif ($PinRequested) {
    Write-Host "WARNING: not running in an STA thread - the COM message filter cannot be registered." -ForegroundColor Yellow
    Write-Host "WARNING: the -TcVersion pin may fail here. Re-run via powershell.exe (STA) if it misbehaves." -ForegroundColor Yellow
}

$dte = $null
# PID of the shell WE started. Stays $null unless we can prove exactly which process that is, and
# Quit() is gated on it - see the census below.
$ownShellPid = $null
try {
    if (-not (Test-Path $SlnPath)) { throw "Solution file not found: $SlnPath" }

    # Census the shells running BEFORE we ask COM for one. They are somebody's - very likely a
    # developer's, with unsaved work - and nothing here may ever reach them.
    #
    # This exists because Quit() below is irreversible and used to be called on a DTE of unknown
    # provenance. Measured on 2026-07-29, `New-Object -ComObject` spawns a NEW shell rather than
    # binding a running one, so no hijack was observed - but that is undocumented COM activation
    # behaviour, not a guarantee, and "we happened to be fine" is not a safety property. The
    # before/after diff turns it into one, without the STA + PowerShell 5.1 requirement that a
    # ROT-by-PID moniker lookup would impose on this script and its callers.
    $shellsBefore = @(Get-Process -Name TcXaeShell -ErrorAction SilentlyContinue |
                      Select-Object -ExpandProperty Id)
    if ($shellsBefore.Count -gt 0) {
        Write-Host "NOTE: $($shellsBefore.Count) XAE Shell(s) already running (PID $($shellsBefore -join ', ')); they will not be touched." -ForegroundColor DarkGray
    }

    Write-Host "Creating $ProgId instance..." -ForegroundColor Cyan
    $dte = New-Object -ComObject $ProgId

    # Which process actually appeared. The shell can take a moment to show up in the process list
    # even though COM has already returned, so poll briefly rather than sampling once.
    for ($N = 0; $N -lt 30 -and -not $ownShellPid; $N++) {
        $new = @(Get-Process -Name TcXaeShell -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty Id |
                 Where-Object { $shellsBefore -notcontains $_ })
        if ($new.Count -eq 1) { $ownShellPid = $new[0]; break }
        if ($new.Count -gt 1) {
            # Someone else launched a shell at the same instant. We cannot tell which is ours, so
            # we will not quit any of them.
            Write-Host "WARNING: $($new.Count) new XAE Shells appeared (PID $($new -join ', ')); cannot identify ours, so it will be left running." -ForegroundColor Yellow
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if ($ownShellPid) {
        Write-Host "Driving shell PID $ownShellPid (ours)." -ForegroundColor DarkGray
    } elseif ($shellsBefore.Count -gt 0) {
        # No new process, but shells were already running: COM handed us one of THEIRS. Quitting it
        # would close a window we did not open. This is the case the census exists to catch.
        Write-Host "WARNING: no new XAE Shell process appeared - COM may have bound an already-running instance. It will NOT be closed; quit it yourself if this build left it open." -ForegroundColor Yellow
    }

    Invoke-ComRetry { $dte.SuppressUI = $true }
    # NOTE: the main window is deliberately NOT hidden yet. The -PinVersion version this pinning
    # mechanism comes from hid it only when it was not pinning, and a hidden window during the
    # environment reload is exactly the condition that makes a version switch fragile. It is hidden
    # after the pin step instead, and only when no actual switch took place.

    # Set when rm.Version is actually changed, as opposed to already being correct. Only a real
    # switch reloads the shell environment, and only then does the main window stay visible.
    $didSwitchVersion = $false

    # Pin the TwinCAT system version BEFORE opening the solution, so the project
    # builds against the libraries it was saved with rather than the newest version
    # installed.
    #
    # Pinning runs on BOTH shells. This used to be gated on the 4026 shell, on the belief that 4024
    # is a single-version install exposing no TcRemoteManager version list. That is false, and
    # measured false on 2026-07-29: the 4024 shell answers GetObject("TcRemoteManager") and lists
    #   3.1.4026.22, 3.1.4026.20, 3.1.4026.19, 3.1.4026.17, 3.1.4024.62, 3.1.4024.50
    # - six versions, MORE than the 4026 shell's four, and the only shell that can see the 4024 ones.
    #
    # That asymmetry is why the list must be read from the shell chosen for the REQUESTED version,
    # never a fixed one: asking the 4026 shell about 3.1.4024.62 reports it missing when it is
    # installed. The ProgId is derived from the requested version, so this is correct by construction.
    # $pinFault is set when the requested version cannot be satisfied AT ALL - a version
    # question, not a COM question. It is deliberately NOT thrown from inside the try below,
    # because that try's catch exists to forgive genuine COM/TcRemoteManager failures. Mixing
    # the two is what let an unsatisfiable pin degrade into a warning and a green build against
    # whatever version the shell happened to default to.
    if ($PinRequested) {
        $pin      = $TcVersion
        $pinFault = $null
        try {
            $rm = Invoke-ComRetry { $dte.GetObject("TcRemoteManager") }

            # Blanks are filtered out because a busy/late-bound COM property can answer $null without
            # throwing, and @($null) is a one-element array - which would sail past the emptiness
            # check below and then match no version at all.
            $available   = @()
            $versionsErr = $null
            try { $available = @(Invoke-ComRetry { $rm.Versions } | Where-Object { $_ }) } catch { $versionsErr = $_ }

            if ($versionsErr -or $available.Count -eq 0) {
                # Never silently permissive: without the list, "is this version installed?" is
                # unanswered, so say the check did not run rather than letting the pin look verified.
                if ($versionsErr) {
                    Write-Host "WARNING: could not read the installed TwinCAT version list from TcRemoteManager: $versionsErr" -ForegroundColor Yellow
                } else {
                    Write-Host "WARNING: TcRemoteManager reported no installed TwinCAT versions." -ForegroundColor Yellow
                }
                Write-Host "WARNING: installed-version check SKIPPED - pinning $TcVersion without confirming it is installed." -ForegroundColor Yellow
            }
            elseif ($available -notcontains $TcVersion) {
                $build = ($TcVersion -split '\.')[2]
                $sameBuild = $available | Where-Object { ($_ -split '\.')[2] -eq $build } | Sort-Object { [version]$_ } -Descending
                if ($sameBuild) {
                    $pin = @($sameBuild)[0]
                    Write-Host "WARNING: exact $TcVersion not installed; using nearest same-build $pin" -ForegroundColor Yellow
                } else {
                    $pinFault = "no installed TwinCAT $build.x version. Installed: $($available -join ', ')"
                }
            }

            if (-not $pinFault) {
                # rm.Version reads back the pinned version, or EMPTY when the pin equals the shell's
                # configured default. Read it first: if the shell is already on the version we want,
                # there is nothing to switch and nothing to wait for.
                #
                # Measured: this shortcut almost never fires. Every run gets a freshly created shell,
                # whose rm.Version reads empty until something sets it, so the switch path is the
                # normal path. Kept because it is correct and free - not because it saves time.
                $rmBefore = try { "$(Invoke-ComRetry { $rm.Version })" } catch { "" }

                if ($rmBefore -eq $pin) {
                    Write-Host "TwinCAT version already active: $pin" -ForegroundColor Cyan
                } else {
                    $didSwitchVersion = $true
                    Invoke-ComRetry { $rm.Version = $pin }

                    # Confirm the switch actually took. Setting rm.Version reloads the shell environment;
                    # it is neither instantaneous nor guaranteed. Without this the script would print
                    # "Pinned" and then build on whatever version the shell kept - the exact silent
                    # wrong-version failure this file exists to prevent.
                    #
                    # An all-empty readback means the pin equals the shell default, which is the common
                    # case here, so that path is capped short rather than waited out for the full window.
                    $state      = 'pending'
                    $cur        = ''
                    $deadline   = (Get-Date).AddSeconds(30)
                    $emptyUntil = (Get-Date).AddSeconds(10)
                    while ($state -eq 'pending' -and (Get-Date) -lt $deadline) {
                        Start-Sleep -Milliseconds 750
                        $cur = try { "$(Invoke-ComRetry { $rm.Version })" } catch { "" }
                        if     ($cur -eq $pin) { $state = 'confirmed' }
                        elseif ($cur -ne '')   { $state = 'mismatch' }
                        elseif ((Get-Date) -ge $emptyUntil) { $state = 'default' }
                    }

                    switch ($state) {
                        'confirmed' { Write-Host "Pinned TwinCAT version: $pin (confirmed)" -ForegroundColor Cyan }
                        'mismatch'  { throw "TcRemoteManager did not honour the pin - rm.Version=[$cur], wanted $pin" }
                        default     { Write-Host "Pinned TwinCAT version: $pin (shell reports its default; assumed equal)" -ForegroundColor Cyan }
                    }
                }
            }
        } catch {
            # Genuine COM / TcRemoteManager failure: warn and build on, as it always has.
            Write-Host "WARNING: TcRemoteManager version pin skipped: $_" -ForegroundColor Yellow
        }
        if ($pinFault) {
            if ($AllowVersionMismatch) {
                Write-Host "WARNING: $pinFault" -ForegroundColor Yellow
                Write-Host "WARNING: version left unpinned (-AllowVersionMismatch); the shell's configured default is used." -ForegroundColor Yellow
            } else {
                # Fatal, and it reaches the outer handler as exit 2.
                throw ("$pinFault`n       Pass -AllowVersionMismatch to build on the shell's configured version anyway.")
            }
        }
    } else {
        # No -TcVersion: the caller did not ask for a specific TwinCAT, so the shell keeps the
        # version it is configured for. The shell ITSELF is still chosen from the project (above),
        # which is the part that actually has to match; overriding the version on top of that would
        # be asserting something the caller never said.
        Write-Host "Using the shell's configured default TwinCAT version (pass -TcVersion to pin one)." -ForegroundColor DarkGray
    }

    # Now it is safe to go headless. If a version switch happened the environment was just reloaded,
    # and the -PinVersion version this is ported from kept the window visible for the whole of a
    # pinned run - so we do too rather than second-guessing a path that is known to work.
    if (-not $didSwitchVersion) {
        try { Invoke-ComRetry { $dte.MainWindow.Visible = $false } } catch { }
    }

    Write-Host "Opening solution (loads the TwinCAT project, may take a while)..." -ForegroundColor Cyan
    # Retried with a fresh Solution reference each attempt: immediately after a version pin the
    # reloaded environment can reject Open with STG_E_FILENOTFOUND until it settles. Invoke-ComRetry
    # alone does not cover this - it retries RPC rejections, and this is a different failure.
    # Without a pin-driven reload the first attempt simply succeeds.
    $opened = $false
    $openErr = $null
    for ($N = 0; $N -lt 25 -and -not $opened; $N++) {
        try { Invoke-ComRetry { $dte.Solution.Open($SlnPath) }; $opened = $true }
        catch { $openErr = $_; Start-Sleep -Seconds 3 }
    }
    if (-not $opened) { throw "could not open $SlnPath after 25 attempts: $openErr" }

    # Wait until the solution reports open and projects are loaded
    for ($N = 0; $N -lt 120; $N++) {
        $open  = Invoke-ComRetry { $dte.Solution.IsOpen }
        $count = Invoke-ComRetry { $dte.Solution.Projects.Count }
        if ($open -and $count -gt 0) { break }
        Start-Sleep -Seconds 2
    }

    # Property access on a busy COM server can return null without throwing,
    # so poll until we get a real SolutionBuild object.
    $sb = $null
    for ($N = 0; $N -lt 60 -and -not $sb; $N++) {
        $sb = Invoke-ComRetry { $dte.Solution.SolutionBuild }
        if (-not $sb) { Start-Sleep -Seconds 2 }
    }
    if (-not $sb) { throw "SolutionBuild object not available." }

    # Activate the requested solution configuration. PlatformName is not exposed
    # on the late-bound SolutionConfiguration, so read it from the configuration's
    # first SolutionContext instead.
    # The configuration list can lag behind the solution reporting "open", so retry
    # until the requested configuration appears rather than failing on the first miss.
    $activated = $false
    for ($N = 0; $N -lt 30 -and -not $activated; $N++) {
        $activated = Invoke-ComRetry {
            $found = $false
            foreach ($cfg in $sb.SolutionConfigurations) {
                $platform = ""
                try { $platform = $cfg.SolutionContexts.Item(1).PlatformName } catch { }
                if ($cfg.Name -eq $ConfigName -and $platform -eq $PlatformName) {
                    $cfg.Activate()
                    $found = $true
                }
            }
            return $found
        }
        if (-not $activated) { Start-Sleep -Seconds 2 }
    }
    if (-not $activated) { throw "Configuration '$ConfigName|$PlatformName' not found in solution." }
    Write-Host "Active configuration: $ConfigName|$PlatformName" -ForegroundColor Cyan

    Write-Host "Building (blocking until done)..." -ForegroundColor Yellow
    Invoke-ComRetry { $sb.Build($true) }

    $failed = Invoke-ComRetry { $sb.LastBuildInfo }
    Write-Host "Projects failed: $failed"

    # Dump error list (best effort - often empty over late-bound COM even on failure;
    # LastBuildInfo above is the authoritative pass/fail signal)
    try {
        $items = $dte.ToolWindows.ErrorList.ErrorItems
        for ($N = 1; $N -le $items.Count; $N++) {
            $it = $items.Item($N)
            Write-Host ("[{0}] {1}({2}): {3}" -f $N, $it.FileName, $it.Line, $it.Description)
        }
    } catch { }

    # On failure the ErrorList is usually empty over COM, so also dump the output
    # window panes (the Build/TwinCAT pane carries the real compiler messages).
    if ($failed -ne 0) {
        Write-Host "----- Output window panes -----" -ForegroundColor Magenta
        try {
            $ow = (Invoke-ComRetry { $dte.Windows.Item("{34E76E81-EE4A-11D0-AE2E-00A0C90FFFC3}") }).Object
            foreach ($pane in $ow.OutputWindowPanes) {
                $doc = $pane.TextDocument
                $sel = $doc.Selection
                $sel.StartOfDocument($false)
                $sel.EndOfDocument($true)
                $txt = $sel.Text
                if ($txt -and $txt.Trim().Length -gt 0) {
                    Write-Host "--- pane: $($pane.Name) ---" -ForegroundColor DarkMagenta
                    Write-Host $txt
                }
            }
        } catch { Write-Host "output pane read failed: $_" -ForegroundColor Yellow }
    }

    if ($failed -eq 0) {
        Write-Host "BUILD SUCCEEDED." -ForegroundColor Green
        $exitCode = 0
    } else {
        Write-Host "BUILD FAILED." -ForegroundColor Red
        $exitCode = 1
    }
}
catch {
    Write-Host "FATAL: $_" -ForegroundColor Red
    Write-Host "AT: $($_.InvocationInfo.PositionMessage)"
    $exitCode = 2
}
finally {
    if ($dte) {
        try { $dte.Solution.Close($false) } catch { }

        # Quit ONLY the shell we can prove we started, and only if that PID is still the process we
        # recorded. Ownership is re-checked here rather than assumed, because Quit() is irreversible
        # and the check made minutes ago may no longer hold. If we could not identify our shell, we
        # leave it running: a stray IDE window is a nuisance, closing someone else's is data loss.
        if ($ownShellPid -and (Get-Process -Id $ownShellPid -ErrorAction SilentlyContinue)) {
            try { $dte.Quit() } catch { }
        } elseif (-not $ownShellPid) {
            Write-Host "NOTE: leaving the XAE Shell open - could not prove which process it is." -ForegroundColor DarkGray
        }

        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dte) | Out-Null
    }
    # Revoke last: the filter must outlive every COM call above, including Quit().
    if ($filterRegistered) { try { [TcBuildMessageFilter]::Revoke() } catch { } }
}
exit $exitCode
