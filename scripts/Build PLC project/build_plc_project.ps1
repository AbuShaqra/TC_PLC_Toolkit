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

.PARAMETER Configuration
    Which solution configuration to build. Defaults to 'Release'.

    Together with -Platform it names one of the configuration/platform combinations the solution
    itself declares - normally 14 of them, Debug and Release for each of the seven platforms listed
    under -Platform. The pair is checked against the solution's own list once it is open, so a
    combination the solution does not declare is reported as
    "Configuration '<config>|<platform>' not found in solution" and exits 2.

.PARAMETER Platform
    Which target platform to build for. Defaults to 'TwinCAT RT (x64)'.

    The platforms a TwinCAT solution normally declares:

        TwinCAT RT (x64)        TwinCAT RT (x86)
        TwinCAT OS (x64)        TwinCAT OS (x64-E)
        TwinCAT OS (ARMV7-A)    TwinCAT OS (ARMV7-M)    TwinCAT OS (ARMV8-A)

    Each name is two independent facts: a runtime KIND - 'TwinCAT RT' is the real-time kernel,
    'TwinCAT OS' a user-mode runtime - and an ARCHITECTURE. One machine can run both kinds at once, so
    with -ActivateConfiguration the platform has to match the runtime being activated ONTO, which is a
    property of that runtime and not of the host; see -ActivateConfiguration, gate 4. Without
    -ActivateConfiguration any declared platform builds freely.

    The default is a BUILD default and nothing more: activating onto a user-mode runtime needs a
    'TwinCAT OS (...)' platform, so -ActivateConfiguration -TargetNetId <a user-mode runtime> normally
    wants -Platform naming that runtime's platform too. Gate 4 says which one when it does not.

    The name is compared literally against the platform of each configuration's first SolutionContext,
    so the spaces, case and parentheses all matter - and it must be quoted, because it contains spaces.

.PARAMETER ActivateConfiguration
    After a SUCCESSFUL build, activate the configuration on the LOCAL host and restart its TwinCAT
    runtime. Off by default; a build never touches the runtime unless this is passed.

    THIS STOPS AND RESTARTS THE LOCAL TWINCAT RUNTIME. Whatever is running stops.

    The target is always this machine. -TargetNetId selects BETWEEN this machine's own runtimes and
    is validated against them, so no argument can steer the activation at a physical station: the
    guarantee is "never leaves this machine", not "not configurable". Four refusals enforce it, all
    BEFORE the IDE launches, and always in this order - which gate reports first is what tells you
    what to fix:

        1. this machine's AmsNetId cannot be determined at all      -> exit 2
        2. -TargetNetId is not one of this machine's                -> exit 2
        3. the solution's .tsproj names a TargetNetId that is not
           one of this machine's                                    -> exit 2
        4. the platform of the chosen target is KNOWN and is not
           -Platform                                                -> exit 2

    Gate 4 refuses only on POSITIVE KNOWLEDGE, and it asks about the chosen target rather than about
    this host. 'TwinCAT RT' is the real-time kernel and 'TwinCAT OS' a user-mode runtime; they are
    different platforms on the same machine, so which one applies is a property of the target, not of
    the host CPU. It is established from that runtime's own files - the platform string in its
    Boot\CurrentConfig.xml when it has been activated at least once, otherwise its runtime kind from
    its TcRegistry.xml with the architecture from this host. Where neither is available the platform is
    unknown, which is normal: the run is ALLOWED with a warning and the XAE Shell performs the
    authoritative check itself. Every value that is not read outright is reported as inferred, on the
    'Target platform:' line and in any refusal.

    Deriving it from the host CPU instead is the bug this replaced: on a 64-bit host that labelled
    every target 'TwinCAT RT (x64)', so a correct 'TwinCAT OS (x64)' activation was refused outright.

    They are decided by Resolve-ActivationTarget, which is pure - no COM, no registry, no filesystem,
    no network - so a refusal costs about a second, launches no IDE, and cannot be flipped into an
    allow by a station being unreachable. A refusal is therefore evidence about the target and never
    evidence about the network.

    A fifth check runs on the live system manager: the target is set to the local NetId and read
    back, and activation is abandoned if the readback disagrees. An unverifiable target is treated as
    unsafe, never as "probably fine".

    Activation makes the IDE window visible for its duration, deliberately: it can raise a licence or
    full-download dialog, and with the UI suppressed that is an invisible hang rather than something
    you can answer.

    Exit code 3 means the build succeeded but activation failed or was refused.

    Success is decided by reading the target's ADS state and requiring RUN (5). It is NOT decided by
    ITcSysManager::IsTwinCatStarted(), which returns $true while the system is in CONFIG - it reports
    that TwinCAT is up, not that it is running. An earlier version of this script trusted it and
    reported a successful activation on a machine that never left Config mode.

.PARAMETER TargetNetId
    Which of THIS MACHINE's runtimes to activate onto, as an AmsNetId. Omit it to use whatever the
    solution opens with, provided that is local.

    A machine can have more than one: a real-time runtime and one or more user-mode runtimes, each
    with its own AmsNetId. The value is validated against this machine's own set and rejected
    otherwise, so it selects between local runtimes and can never name a remote station - the
    guarantee is "never leaves this machine", not "not configurable".

    Use it when the real-time runtime cannot start. If Hyper-V or VBS is active, the hypervisor owns
    the cores, the real-time kernel cannot isolate one, and the target stays in CONFIG no matter how
    often it is activated. A user-mode runtime does not need the real-time kernel and reaches RUN
    normally.

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
    .\build_plc_project.ps1 MyProject -Configuration Debug -Platform 'TwinCAT OS (ARMV8-A)'

    Build a configuration other than the default Release | TwinCAT RT (x64). The pair must be one the
    solution declares, or the run exits 2 with "not found in solution".

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
    parameter error. The build configuration is NOT hardcoded: -Configuration and -Platform select it
    and default to 'Release' and 'TwinCAT RT (x64)', which is what every run used before they existed.
    The pair is validated against the configurations the solution actually declares, and naming one it
    does not declare is fatal (exit 2).

    Resolve-TwinCatTarget below is deliberately COM-free and is the one part of the version logic
    testable without a TwinCAT installation - see test-resolve-twincat-target.ps1, beside this script.
    Resolve-ActivationTarget is the same idea for the activation gates - see test-activation-target.ps1,
    also beside this script. Those tests matter more than they look: a refusal cannot be demonstrated
    end to end without a station that answers, and a station that answers is precisely the thing that
    must never be activated onto by accident, so the unit tests are the only coverage that path has.

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
    [switch]$AllowVersionMismatch,
    # See .PARAMETER Configuration / .PARAMETER Platform above. The defaults are what this script
    # built before they were parameters, so omitting both is byte-for-byte the old behaviour. The
    # pair is validated against the solution's own configuration list once it is open, not here.
    [string]$Configuration = 'Release',
    [string]$Platform      = 'TwinCAT RT (x64)',
    # See .PARAMETER ActivateConfiguration above. Deliberately verbose: this script already contains
    # an unrelated Activate() call (Visual Studio's SolutionConfiguration.Activate, which merely picks
    # the configuration in the IDE). PowerShell prefix-matching still accepts -Activate at a prompt.
    [switch]$ActivateConfiguration,
    # See .PARAMETER TargetNetId above. Validated against THIS MACHINE's own AmsNetIds and rejected
    # otherwise, so it selects between local runtimes (real-time vs user-mode) and can never name a
    # remote station.
    [string]$TargetNetId
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

# The configuration to build, straight from -Configuration / -Platform.
$ConfigName   = $Configuration
$PlatformName = $Platform

# Check the pair BEFORE COM, against the .sln's own declaration. The authoritative check still runs
# later against the live SolutionConfigurations - this one exists because that check happens after
# the IDE is up, so a typo'd platform used to cost a full shell launch (tens of seconds) to discover.
# Every other argument error in this script surfaces in well under a second; this one now does too.
#
# The .sln declares its combinations as `Release|TwinCAT RT (x64) = Release|TwinCAT RT (x64)` inside
# GlobalSection(SolutionConfigurationPlatforms). Absent or unparseable, say nothing and let the live
# check decide - a missing section is not evidence the configuration is wrong.
$declared = @()
try {
    $slnText = Get-Content -LiteralPath $SlnPath -Raw -ErrorAction Stop
    $section = [regex]::Match($slnText,
        '(?ms)^\s*GlobalSection\(SolutionConfigurationPlatforms\).*?^\s*EndGlobalSection')
    if ($section.Success) {
        $declared = @([regex]::Matches($section.Value, '(?m)^\s*([^=\r\n]+?)\s*=') |
                      ForEach-Object { $_.Groups[1].Value } |
                      Where-Object { $_ -notmatch '^GlobalSection' })
    }
} catch { }

if ($declared.Count -gt 0 -and ($declared -notcontains "$ConfigName|$PlatformName")) {
    Write-Host "FATAL: '$ConfigName|$PlatformName' is not declared by this solution." -ForegroundColor Red
    Write-Host "Available:" -ForegroundColor Red
    $declared | Sort-Object | ForEach-Object { Write-Host "  $_" }
    exit 2
}

# ----------------------------------------------------------------------------
# Activation target. Everything here runs BEFORE any COM object exists, so the
# refusals below cost about a second and never launch an IDE.
# ----------------------------------------------------------------------------

<#
.SYNOPSIS
    The Platform= a runtime's own boot configuration reports, or $null when it cannot be read.
.DESCRIPTION
    A boot project records the platform it was activated for, on its root element:

        <TcBootProject CreateTime="2026-07-30T08:30:30" Platform="TwinCAT OS (x64)">

    That is the one place a LOCAL runtime's platform can be read without asking the IDE, and it is
    authoritative: it is the value the XAE Shell compares the build's platform against.

    The file only exists once the runtime has been activated at least once, so $null is a normal,
    permanent answer for a fresh runtime and never an error.

    Only the head of the file is read - the root element is its second line, and a boot project for a
    real configuration can run to megabytes.
#>
function Get-TcBootPlatform {
    param([string]$Path)
    if (-not $Path) { return $null }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $head = (Get-Content -LiteralPath $Path -TotalCount 40 -ErrorAction Stop) -join "`n"
        $m = [regex]::Match($head, '(?i)<TcBootProject\b[^>]*?\bPlatform="([^"]+)"')
        if ($m.Success) { return $m.Groups[1].Value }
    } catch { }
    return $null
}

<#
.SYNOPSIS
    'TwinCAT OS' when a runtime's own registry store marks it a user-mode runtime; $null otherwise.
.DESCRIPTION
    MEASURED on one machine (2026-07-30), not read out of documentation. Each user-mode runtime's
    <name>\3.1\TcRegistry.xml - the same file the AmsNetId comes from - carries

        <Key Name="Ident">
            <Value Name="DeviceType" Type="SZ">PC-WIN-U</Value>
        </Key>

    and, under its System key, <Value Name="RunAsDevice" Type="DW">1</Value>. Reading the trailing
    '-U' of PC-WIN-U as "usermode" is an INFERENCE from the runtimes present there; RunAsDevice is
    taken as a corroborating signal, and either one alone is accepted.

    This is strictly better than the boot configuration for THIS half of the answer: TcRegistry.xml
    exists from the moment a runtime is created, where CurrentConfig.xml appears only after a first
    activation. It is what closes the "unknown platform" hole for a never-activated user-mode runtime.

    Anything else returns $null deliberately - DeviceType absent, or present with some other value
    (PC-WIN, a CE-style string). An unrecognised device type is not evidence of user-mode, and the
    permissive path (unknown -> allow with a warning, and let the XAE Shell check) is the right answer
    there. Do not add a guess here.

    Routes tried for the REAL-TIME runtime and rejected, so nobody re-treads them:
      * no Ident key, DeviceType value or RunAsDevice flag exists anywhere under Beckhoff in either
        registry hive (both searched to depth 4, 2026-07-30), and PC-WIN appears in no config file
        other than the user-mode TcRegistry.xml files. The real-time runtime is therefore identified
        by the ABSENCE of a usermode marker on a NetId that came from the Windows registry.
      * AdsSyncReadDeviceInfoReq on port 10000 answers identically for a real-time and a user-mode
        target ('TwinCAT System', 3.1.4026) - no platform information at all.
      * the registry-over-ADS service (IndexGroup 0x6E, SYSTEMSERVICE_REG_HKEYLOCALMACHINE) returns
        0x705 ADSERR_DEVICE_SERVICENOTSUPP on every local target on 4026.
#>
function Get-TcRuntimeKind {
    param([string]$RegistryXmlPath)
    if (-not $RegistryXmlPath) { return $null }
    $text = $null
    try {
        if (-not (Test-Path -LiteralPath $RegistryXmlPath -PathType Leaf)) { return $null }
        $text = Get-Content -LiteralPath $RegistryXmlPath -Raw -ErrorAction Stop
    } catch { return $null }
    if ([regex]::IsMatch($text, '(?i)<Value\s+Name="DeviceType"[^>]*>\s*PC-WIN-U\s*</Value>')) { return 'TwinCAT OS' }
    if ([regex]::IsMatch($text, '(?i)<Value\s+Name="RunAsDevice"[^>]*>\s*0*1\s*</Value>'))     { return 'TwinCAT OS' }
    return $null
}

<#
.SYNOPSIS
    A local runtime's platform string for a KIND the caller has established, with the architecture -
    and only the architecture - taken from this host.
.DESCRIPTION
    A TwinCAT platform string is TWO independent facts: a runtime KIND - 'TwinCAT RT' is the real-time
    kernel, 'TwinCAT OS' a user-mode runtime - and an ARCHITECTURE (x64, x86, ARMV8-A, ...). The host
    CPU decides the second half and says nothing whatsoever about the first.

    THIS FUNCTION USED TO SUPPLY BOTH HALVES, FOR EVERY TARGET, AND THAT WAS THE BUG. On a 64-bit host
    it labelled user-mode runtimes 'TwinCAT RT (x64)', so a correct 'TwinCAT OS (x64)' activation was
    refused as un-runnable and 'TwinCAT RT (x64)' demanded instead - whereupon the XAE Shell failed
    that activation itself with

        Aktive Plattform 'TwinCAT RT (x64)' unterscheidet sich von der aktuellen Zielplattform
        'TwinCAT OS (x64)'!

    -Kind is now a parameter, so the host CANNOT supply it: the caller must have established it from
    the target's own files (Get-TcRuntimeKind), or from the absence of a usermode marker on a
    registry-derived NetId, which is what the 'TwinCAT RT' default is for. The architecture remains an
    inference - a 32-bit real-time runtime on a 64-bit host would be mislabelled - so every caller
    carries a provenance beside the value and prints it.

    A runtime's own CurrentConfig.xml always wins over this; Resolve-RuntimePlatform is where that
    precedence lives.

    The system manager is no help: measured 2026-07-29, its SYSTEM/real-time tree items carry
    TargetCPUInfo (CPUFamily, CPUType, core affinities) but no "TwinCAT RT (x64)"-shaped value, and
    GetTargetVersion does not exist on this build at all.
#>
function Get-LocalRuntimePlatform {
    param([ValidateSet('TwinCAT RT', 'TwinCAT OS')][string]$Kind = 'TwinCAT RT')
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
    return "$Kind ($arch)"
}

<#
.SYNOPSIS
    One runtime's platform, and how much of it was actually read.
.DESCRIPTION
    Pure - no filesystem, no registry - so the PRECEDENCE below is testable without a TwinCAT
    installation (test-activation-target.ps1). The caller does the reading; this decides what the
    readings mean:

        -BootPlatform given                    -> that string,  Provenance 'read'
        else -KindPlatform, -KindSource 'read'  -> that string,  Provenance 'architecture-inferred'
        else -KindPlatform, otherwise           -> that string,  Provenance 'kind-inferred'
        else                                    -> $null        (unknown)

    A FULL STRING READ FROM THE BOOT CONFIGURATION ALWAYS WINS. It is what the XAE Shell compares
    against, and it is the only source that states the architecture rather than assuming this host's.
    The assembled forms exist because that file only appears after a first activation.

    The three provenances are not decoration. They rank how much of the answer was measured:

        read                    both halves came from the target's own boot configuration
        architecture-inferred   the kind was read from the target's registry store; the architecture
                                is this host's
        kind-inferred           the kind came from the absence of a usermode marker (so: the real-time
                                runtime) and the architecture is this host's

    Unknown is a normal answer, not an error - Resolve-ActivationTarget warns and allows rather than
    guessing, and the XAE Shell performs the authoritative check anyway.
#>
function Resolve-RuntimePlatform {
    param(
        [string]$BootPlatform,
        [string]$KindPlatform,
        [ValidateSet('read', 'inferred', '')][string]$KindSource = ''
    )
    if ($BootPlatform) {
        return [pscustomobject]@{ Platform = $BootPlatform; Provenance = 'read' }
    }
    if ($KindPlatform) {
        $provenance = if ($KindSource -eq 'read') { 'architecture-inferred' } else { 'kind-inferred' }
        return [pscustomobject]@{ Platform = $KindPlatform; Provenance = $provenance }
    }
    return $null
}

<#
.SYNOPSIS
    One record per user-mode runtime found under a Runtimes root: NetId, platform, provenance.
.DESCRIPTION
    ONE WALK, TWO ANSWERS, because the second is only trustworthy when it comes from the same place as
    the first. Each runtime folder holds everything needed about that runtime:

        <name>\3.1\TcRegistry.xml               its AmsNetId, and its DeviceType/RunAsDevice marker
        <name>\3.1\Boot\CurrentConfig.xml        its platform, once it has been activated at least once

    THE FILES ARE PAIRED BY FOLDER, and recursion is per runtime folder rather than from the root for
    exactly that reason: nothing inside either file ties them together, so the folder is the only
    reliable association. A single recursive sweep of the root cannot tell which file belongs to which
    runtime - do not "simplify" it back into one.

    -RuntimesRoot is a parameter, not a constant, so this is testable against fixture folders (see
    test-activation-target.ps1) instead of only against whatever this machine happens to have
    installed. The live caller passes
    <ProgramData>\Beckhoff\TwinCAT\3.1\Runtimes.

    Returns, per NetId: NetId, Platform ($null when unknown), Provenance, Kind ('user-mode'), Source.
#>
function Get-UserModeRuntimeRecords {
    param([Parameter(Mandatory)][string]$RuntimesRoot)

    $records = @()
    if (-not (Test-Path -LiteralPath $RuntimesRoot)) { return $records }

    foreach ($dir in @(Get-ChildItem -LiteralPath $RuntimesRoot -Directory -ErrorAction SilentlyContinue |
                       Sort-Object Name)) {
        $regFiles = @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -Filter 'TcRegistry.xml' `
                                    -File -ErrorAction SilentlyContinue | Sort-Object FullName)
        if ($regFiles.Count -eq 0) { continue }      # not a runtime - e.g. the shared 'bin' folder

        $bootPlatform = $null
        foreach ($cc in @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -Filter 'CurrentConfig.xml' `
                                        -File -ErrorAction SilentlyContinue | Sort-Object FullName)) {
            if (-not $bootPlatform) { $bootPlatform = Get-TcBootPlatform -Path $cc.FullName }
        }

        # The KIND comes from this runtime's own files; only the architecture comes from the host, and
        # only when the kind was established. An unrecognised marker leaves the platform unknown rather
        # than guessing 'TwinCAT OS' - see Get-TcRuntimeKind.
        $kind = $null
        foreach ($reg in $regFiles) {
            if (-not $kind) { $kind = Get-TcRuntimeKind -RegistryXmlPath $reg.FullName }
        }
        $kindPlatform = $null
        if ($kind) { $kindPlatform = Get-LocalRuntimePlatform -Kind $kind }
        $resolved = Resolve-RuntimePlatform -BootPlatform $bootPlatform -KindPlatform $kindPlatform `
                                            -KindSource 'read'

        # <Value Name="AmsNetId" Type="BIN">C63364040101</Value>  ->  198.51.100.4.1.1
        foreach ($reg in $regFiles) {
            $text = $null
            try { $text = Get-Content -LiteralPath $reg.FullName -Raw -ErrorAction Stop } catch { continue }
            foreach ($m in [regex]::Matches($text, '(?i)<Value\s+Name="AmsNetId"[^>]*>\s*([0-9A-F]{12})\s*</Value>')) {
                $hex = $m.Groups[1].Value
                $records += [pscustomobject]@{
                    NetId      = ((0..5 | ForEach-Object { [Convert]::ToInt32($hex.Substring($_ * 2, 2), 16) }) -join '.')
                    Platform   = $(if ($resolved) { $resolved.Platform }   else { $null })
                    Provenance = $(if ($resolved) { $resolved.Provenance } else { $null })
                    Kind       = 'user-mode'
                    Source     = $dir.FullName
                }
            }
        }
    }

    return $records
}

<#
.SYNOPSIS
    Every local runtime this machine has: its AmsNetId, its platform, and how that was learned.
.DESCRIPTION
    A machine has a real-time runtime and zero or more user-mode runtimes. Each has its own AmsNetId
    AND its own platform; neither is a property of the machine, which is the whole reason this returns
    a per-runtime record rather than one answer.

    Where each part comes from:

        user-mode   Get-UserModeRuntimeRecords, under <ProgramData>\Beckhoff\TwinCAT\3.1\Runtimes
        real-time   HKLM\...\Beckhoff\TwinCAT3\System  AmsNetId                             NetId
                    <TwinCATDir>\3.1\Boot\CurrentConfig.xml, else 'TwinCAT RT' + host arch  platform

    The real-time pairing is by construction: the install directory is read from the parent of the very
    key the NetId came from. Its KIND is not read anywhere - no usermode marker exists for it (see
    Get-TcRuntimeKind) - so a registry-derived NetId with no such marker IS the real-time runtime. That
    is a sound reading rather than a guess, but it is an inference, and it is reported as one.

    Returns, per NetId: NetId, Platform ($null when unknown), Provenance ('read' /
    'architecture-inferred' / 'kind-inferred' / $null), Kind ('real-time' / 'user-mode'), Source.
#>
function Get-LocalRuntimeRecords {
    $records = @()

    # The real-time runtime. Both registry views are read - a 32-bit TwinCAT on a 64-bit host writes
    # under WOW6432Node - and both are kept, exactly as they were when only NetIds were collected.
    foreach ($key in 'HKLM:\SOFTWARE\WOW6432Node\Beckhoff\TwinCAT3\System',
                     'HKLM:\SOFTWARE\Beckhoff\TwinCAT3\System') {
        $raw = $null
        try { $raw = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).AmsNetId } catch { continue }
        if (-not $raw -or $raw.Count -lt 6) { continue }

        # 4026 installs to <ProgramFiles(x86)>\Beckhoff\TwinCAT\ and 4024 to C:\TwinCAT\; both are
        # tried, and neither has a Boot\ until the real-time runtime has been activated once.
        $installDir = $null
        try {
            $installDir = (Get-ItemProperty -LiteralPath (Split-Path -Parent $key) -ErrorAction Stop).TwinCATDir
        } catch { }
        $bootPlatform = $null
        foreach ($candidate in @(
                    $(if ($installDir) { Join-Path $installDir '3.1\Boot\CurrentConfig.xml' } else { $null }),
                    'C:\TwinCAT\3.1\Boot\CurrentConfig.xml')) {
            if (-not $bootPlatform) { $bootPlatform = Get-TcBootPlatform -Path $candidate }
        }

        $resolved = Resolve-RuntimePlatform -BootPlatform $bootPlatform `
                                            -KindPlatform (Get-LocalRuntimePlatform -Kind 'TwinCAT RT') `
                                            -KindSource 'inferred'
        $records += [pscustomobject]@{
            NetId      = (($raw[0..5] | ForEach-Object { [int]$_ }) -join '.')
            Platform   = $(if ($resolved) { $resolved.Platform }   else { $null })
            Provenance = $(if ($resolved) { $resolved.Provenance } else { $null })
            Kind       = 'real-time'
            Source     = $key
        }
    }

    $records += Get-UserModeRuntimeRecords -RuntimesRoot (Join-Path $env:ProgramData 'Beckhoff\TwinCAT\3.1\Runtimes')

    return @($records | Where-Object { $_.NetId })
}

<#
.SYNOPSIS
    Every AmsNetId that demonstrably belongs to THIS machine.
.DESCRIPTION
    Two sources, because one is not enough. The registry holds the system's own NetId, but a TwinCAT
    4026 install also creates user-mode runtimes whose TcRegistry.xml carries a DIFFERENT NetId that
    is nevertheless local. Comparing against the registry value alone would refuse a perfectly local
    activation on any machine whose target resolves to a user-mode runtime.

    Both now come from Get-LocalRuntimeRecords, which walks each runtime once for the NetId and the
    platform together. THE RETURN CONTRACT HERE IS UNCHANGED and deliberately narrow - a sorted, unique
    list of NetId strings - because it is the membership set every activation gate tests against.
#>
function Get-LocalAmsNetIds {
    return @(Get-LocalRuntimeRecords | ForEach-Object { $_.NetId } |
             Where-Object { $_ } | Sort-Object -Unique)
}

<#
.SYNOPSIS
    NetId -> platform for every local runtime, ready to hand to Resolve-ActivationTarget.
.DESCRIPTION
    The platform is a property of the TARGET, not of this machine, so it is looked up PER NetId. See
    Get-LocalRuntimePlatform for what deriving it from the host CPU cost.

    Every local NetId gets a key, so a caller can tell "this runtime's platform is unknown" from "that
    is not a runtime of this machine". The value is:

        $null        neither half of the platform could be established, and it must not be guessed
        an object    Platform    'TwinCAT OS (x64)', 'TwinCAT RT (x64)', ...
                     Provenance  'read' / 'architecture-inferred' / 'kind-inferred', ranking how much
                                 of it was measured - see Resolve-RuntimePlatform. Anything inferred
                                 can be wrong, so it is always reported as inferred.

    A known platform never loses to an unknown one when two records carry the same NetId.
#>
function Get-LocalRuntimePlatforms {
    $map = @{}
    foreach ($r in Get-LocalRuntimeRecords) {
        if (-not $r.NetId) { continue }
        if ($map.ContainsKey($r.NetId) -and $map[$r.NetId]) { continue }
        $map[$r.NetId] = $(if ($r.Platform) {
                               [pscustomobject]@{ Platform = $r.Platform; Provenance = $r.Provenance }
                           } else { $null })
    }
    return $map
}

<#
.SYNOPSIS
    One console line describing a target's platform, provenance included.
.DESCRIPTION
    Printed rather than kept private: an inferred platform can be wrong (see Get-LocalRuntimePlatform),
    and a refusal a caller cannot explain is worse than one they can argue with. 'unknown' is printed
    explicitly too - saying nothing there reads as "there was nothing to check".

    Resolve-ActivationTarget words the same facts differently in its refusal. That duplication is
    deliberate: the function must stay self-contained, because the tests lift it out of this file on
    its own.
#>
function Format-RuntimePlatform {
    param($Entry)
    if ($Entry -is [string]) {
        if ($Entry) { return "$Entry" }
        $Entry = $null
    }
    if (-not $Entry -or -not $Entry.Platform) {
        return 'unknown  (not determined here - the XAE Shell checks the platform during activation)'
    }
    switch ([string]$Entry.Provenance) {
        'read'                  { return "$($Entry.Platform)  (read from this runtime's boot configuration)" }
        'architecture-inferred' { return ("$($Entry.Platform)  (kind read from this runtime's registry " +
                                          "store; architecture inferred from this host)") }
        'kind-inferred'         { return ("$($Entry.Platform)  (kind inferred from the absence of a " +
                                          "user-mode marker; architecture inferred from this host)") }
        default                 { return "$($Entry.Platform)" }
    }
}

<#
.SYNOPSIS
    Decides which target an activation may use, and refuses anything that cannot be proven local.
.DESCRIPTION
    The four pre-IDE activation refusals, in one place and in one order. Pure by design - no COM, no
    registry, no filesystem, no network - for the same two reasons Resolve-TwinCatTarget is: it runs
    BEFORE the IDE exists, so a refusal costs about a second instead of a shell startup, and being
    pure is what makes it testable without a TwinCAT installation (test-activation-target.ps1).

    Purity is also the safety argument. The gates are a set-membership test over NetIds the CALLER
    measured; there is no network call anywhere in here, so an unreachable station cannot turn a
    refusal into an allow, and a reachable one cannot turn an allow into a refusal. That is why a
    refusal is evidence about the target and never evidence about the network.

        -LocalNetIds      every AmsNetId that demonstrably belongs to this machine (Get-LocalAmsNetIds).
                          Blank entries are dropped, exactly as that function drops them; an empty set
                          means "not determined", not "none".
        -RequestedNetId   what the caller passed to -TargetNetId, or nothing.
        -ProjectNetId     the TargetNetId the solution's .tsproj names, or nothing.
        -Platform         the platform about to be built (-Platform).
        -TargetPlatforms  NetId -> that runtime's platform, for THIS MACHINE's runtimes
                          (Get-LocalRuntimePlatforms). Each value is $null when the platform could not
                          be established, or an object with a Platform and a Provenance; a bare
                          platform string is accepted too. Omit it and nothing is known, so gate 4
                          never refuses.
        -Configuration    only so the platform refusal can suggest '<config>|<target platform>'.

        -Returns          TargetNetId, TargetSource, RequestedNetId, ProjectNetId, LocalNetIds,
                          Platform, TargetPlatform, TargetProvenance, Warnings (string[])

    GATE 4 REFUSES ONLY ON POSITIVE KNOWLEDGE, and it asks about THE TARGET IT JUST CHOSE - not about
    this host. A platform string is a runtime KIND ('TwinCAT RT' = the real-time kernel, 'TwinCAT OS' =
    a user-mode runtime) plus an ARCHITECTURE, and one machine runs both kinds at once, so there is no
    such thing as "the platform this host can run":

        known and equal      -> allowed (case-insensitively, as -ne is)
        known and different  -> refused, naming both platforms and how the target's was established
        unknown              -> ALLOWED, with a warning on the result

    Being permissive when nothing is known is deliberate. The XAE Shell performs this check itself and
    reports it accurately, so an unverified allow costs one failed activation with a clear message,
    while being wrongly strict makes a correct configuration impossible to activate at all. That is not
    hypothetical: deriving the platform from the host CPU refused a correct 'TwinCAT OS (x64)'
    activation and demanded 'TwinCAT RT (x64)' instead - see Get-LocalRuntimePlatform.

    ORDER IS PART OF THE CONTRACT. An undetermined local set is reported before anything else because
    without it no other question has a meaningful answer; an explicitly requested target is reported
    before one the project merely happens to name, because the caller's own argument is the thing they
    can fix; and the platform is reported last because it is the only gate that is not about
    LOCALNESS. Reordering these changes which refusal a caller sees when two gates trip at once.
    Choosing the target moved above gate 4 - a choice is not a refusal, and the order the REFUSALS
    fire in is unchanged.

    TargetNetId is the PRE-COM preference: -TargetNetId when given, otherwise the first local NetId.
    It is not the final word - the activation block later reads the target the solution actually
    opened with and keeps THAT when it is local too, which is a fact no pure function can know. What
    this decides is which target is used when the live one is not local, and -TargetNetId still wins
    over both.

    No syntactic validation of a NetId is done, deliberately: membership in the measured local set is
    the entire test. A well-formed remote NetId must be refused just the same, and a malformed local
    one is still local. Comparison is PowerShell's -contains, so it is case-insensitive and does NOT
    trim - a NetId carrying stray whitespace is not the same NetId and is refused rather than coerced.

    Throws on every refusal, like Resolve-TwinCatTarget, with the continuation lines already indented
    so a single `Write-Host "FATAL: $_"` reproduces the message verbatim.
#>
function Resolve-ActivationTarget {
    param(
        [string[]]$LocalNetIds,
        [string]$RequestedNetId,
        [string]$ProjectNetId,
        [Parameter(Mandatory)][string]$Platform,
        [hashtable]$TargetPlatforms,
        [string]$Configuration = 'Release'
    )

    # [Environment]::NewLine, not "`n": the caller prints the whole message with one Write-Host, and
    # the lines it replaced were separate Write-Host calls. Anything but a CRLF changes those bytes.
    $nl = [Environment]::NewLine

    # Same filter Get-LocalAmsNetIds applies to its own result, repeated because this function must
    # also be correct for a caller that hands it $null or a list with holes in it.
    $local = @($LocalNetIds | Where-Object { $_ })

    if ($local.Count -eq 0) {
        throw ("cannot determine this machine's AmsNetId, so an activation target cannot be" + $nl +
               "       proven local. Refusing to activate. (Is TwinCAT installed?)")
    }

    # -TargetNetId selects BETWEEN THIS MACHINE'S OWN runtimes - typically the real-time one and a
    # user-mode one, which have different NetIds. Validated against the local set and rejected
    # otherwise, so it cannot name a remote station: the safety property is "never leaves this
    # machine", not "never configurable". The local set is named in the message because the whole
    # point of the refusal is to show what WAS acceptable.
    #
    # `if ($RequestedNetId)` rather than an IsNullOrWhiteSpace test: a whitespace-only argument is
    # something the caller typed, so it is refused as a non-local NetId rather than ignored.
    if ($RequestedNetId) {
        if ($local -notcontains $RequestedNetId) {
            throw ("-TargetNetId $RequestedNetId is not an AmsNetId of this machine." + $nl +
                   "       Local: $($local -join ', ')" + $nl +
                   "       Activation is local-only; a remote target cannot be selected here.")
        }
    }

    # A .tsproj can name a target, and on a real machine project that target is a physical station.
    # This fires with or without -TargetNetId - the project naming a rig is a fact about the project,
    # and passing a local -TargetNetId does not make it untrue.
    if ($ProjectNetId -and ($local -notcontains $ProjectNetId)) {
        throw ("this solution names TargetNetId $ProjectNetId, which is not this machine." + $nl +
               "       Activation is local-only and there is no override. Refusing before the IDE starts.")
    }

    # The target, chosen BEFORE gate 4 because gate 4 is a question about THAT target. Choosing is not
    # a gate and cannot refuse anything, so the order the refusals fire in is unchanged.
    $chosen = $local[0]
    $source = 'first-local'
    if ($RequestedNetId) { $chosen = $RequestedNetId; $source = 'requested' }

    # Gate 4. Look the CHOSEN target up; a platform known for some other runtime says nothing about
    # this one. A bare string is accepted as well as a {Platform;Provenance} object so a caller with
    # only the platform to hand is not forced to wrap it.
    $targetPlatform   = $null
    $targetProvenance = $null
    if ($TargetPlatforms -and $TargetPlatforms.ContainsKey($chosen)) {
        $entry = $TargetPlatforms[$chosen]
        if ($entry -is [string]) { $targetPlatform = $entry }
        elseif ($null -ne $entry) {
            $targetPlatform   = [string]$entry.Platform
            $targetProvenance = [string]$entry.Provenance
        }
    }

    # How much of the target's platform was actually measured, in words. An inference can be wrong, and
    # a refusal the caller cannot explain is worse than one they can argue with. Worded here rather
    # than shared with Format-RuntimePlatform because this function is lifted out of the file on its
    # own by its tests and must stay self-contained.
    $how = ''
    switch ($targetProvenance) {
        'read'                  { $how = " (read from that runtime's boot configuration)" }
        'architecture-inferred' { $how = ' (kind read from that runtime; architecture inferred from' +
                                         ' this host, so it can be wrong)' }
        'kind-inferred'         { $how = ' (kind inferred from the absence of a user-mode marker,' +
                                         ' architecture from this host, so it can be wrong)' }
    }

    $warnings = @()
    if (-not $targetPlatform) {
        # Unknown is ALLOWED, not refused: see the header. Warn, and let the XAE Shell decide.
        $warnings += ("the platform of activation target $chosen could not be established, so " +
                      "'$Platform' was not verified against it. The XAE Shell checks it during " +
                      "activation and reports a mismatch accurately.")
    }
    elseif ($Platform -ne $targetPlatform) {
        # Cross-compiling is fine; cross-ACTIVATING is not. -ne is case-insensitive, so only a
        # genuinely different platform is refused, not a differently-capitalised spelling of the same.
        throw ("platform '$Platform' is not the platform of activation target $chosen," + $nl +
               "       which runs '$targetPlatform'$how." + $nl +
               "       Build it without -ActivateConfiguration to cross-compile, or select" + $nl +
               "       '$Configuration|$targetPlatform' to build and activate here.")
    }

    return [pscustomobject]@{
        TargetNetId      = $chosen
        TargetSource     = $source
        RequestedNetId   = $RequestedNetId
        ProjectNetId     = $ProjectNetId
        LocalNetIds      = [string[]]$local
        Platform         = $Platform
        TargetPlatform   = $targetPlatform
        TargetProvenance = $targetProvenance
        Warnings         = [string[]]$warnings
    }
}

<#
.SYNOPSIS
    The real ADS state of a target's system service, or $null if it cannot be read.
.DESCRIPTION
    THE ONLY TRUSTWORTHY RUN/CONFIG ANSWER. The system manager exposes no state member -
    GetTargetState, GetAdsState, GetAppState and seven similar names are all absent (measured by
    IDispatch::GetIDsOfNames, 2026-07-29). The one member it does have, IsTwinCatStarted(), returns
    a genuine Boolean $true while the system sits in CONFIG: it reports that TwinCAT is *up*, not
    that it is *running*. Trusting it is how an activation on a Config-mode machine was once
    reported as succeeded.

    ADS answers properly. State 5 is RUN; 15/16 are CONFIG/RECONFIG. TcAdsDll ships with TwinCAT,
    which this script already requires, so this adds no dependency.
#>
function Get-TcAdsState {
    param([Parameter(Mandatory)][string]$NetId)

    if (-not ('TcAdsState' -as [type])) {
        $dllDir = @(
            "${env:ProgramFiles(x86)}\Beckhoff\TwinCAT\Common64",
            "$env:ProgramFiles\Beckhoff\TwinCAT\Common64",
            "${env:ProgramFiles(x86)}\Beckhoff\TwinCAT\Common32"
        ) | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'TcAdsDll.dll')) } | Select-Object -First 1
        if (-not $dllDir) { return $null }
        $env:PATH = "$dllDir;$env:PATH"
        Add-Type @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct TcAmsAddr { [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] netId; public ushort port; }
public static class TcAdsState {
    [DllImport("TcAdsDll.dll")] public static extern int AdsPortOpen();
    [DllImport("TcAdsDll.dll")] public static extern int AdsPortClose();
    [DllImport("TcAdsDll.dll")] public static extern int AdsSyncReadStateReq(ref TcAmsAddr pAddr, ref ushort pAdsState, ref ushort pDeviceState);
}
'@
    }
    try {
        $addr = New-Object TcAmsAddr
        $addr.netId = [byte[]]($NetId -split '\.' | ForEach-Object { [byte]$_ })
        $addr.port  = 10000                       # AMSPORT_R0_SYSTEMSERVICE
        [void][TcAdsState]::AdsPortOpen()
        $ads = [uint16]0; $dev = [uint16]0
        $hr = [TcAdsState]::AdsSyncReadStateReq([ref]$addr, [ref]$ads, [ref]$dev)
        [void][TcAdsState]::AdsPortClose()
        if ($hr -ne 0) { return $null }
        return [int]$ads
    } catch { return $null }
}

$TcAdsStateNames = @{ 0='INVALID'; 1='IDLE'; 2='RESET'; 3='INIT'; 4='START'; 5='RUN'; 6='STOP'
                      7='SAVECFG'; 8='LOADCFG'; 9='POWERFAILURE'; 10='POWERGOOD'; 11='ERROR'
                      12='SHUTDOWN'; 13='SUSPEND'; 14='RESUME'; 15='CONFIG'; 16='RECONFIG' }

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

$LocalAmsNetIds       = @()
$LocalTargetPlatforms = @{}
$ActivationTarget     = $null
if ($ActivateConfiguration) {
    # Everything measured here is measured HERE, not inside Resolve-ActivationTarget: the registry,
    # the runtime XMLs, the host architecture and the .tsproj are all impure, and keeping them out of
    # the decision is what makes the decision testable. This block gathers facts and prints; the
    # function decides.
    $LocalAmsNetIds = Get-LocalAmsNetIds
    if ($LocalAmsNetIds.Count -gt 0) {
        Write-Host ("Local AmsNetId(s):       {0}" -f ($LocalAmsNetIds -join ', ')) -ForegroundColor Cyan
    }

    # Per TARGET, never per host: one machine runs a real-time and one or more user-mode runtimes, and
    # they are different platforms. See Get-LocalRuntimePlatforms.
    $LocalTargetPlatforms = Get-LocalRuntimePlatforms

    # A .tsproj can name a target, and on a real machine project that target is a physical station.
    # Catch it statically - the alternative is discovering it with the IDE open and a rig connected.
    $projTarget = $null
    try {
        $m2 = Select-String -Path $tsproj.FullName -Pattern 'TargetNetId="([0-9.]+)"' -ErrorAction SilentlyContinue |
              Select-Object -First 1
        if ($m2) { $projTarget = $m2.Matches[0].Groups[1].Value }
    } catch { }

    # Echoed BEFORE the decision, and gated on the same membership the decision enforces, so the
    # ordering of these lines against a refusal is exactly what it was when the gates were inline: a
    # non-local -TargetNetId is reported by the refusal and never echoed as if it had been accepted,
    # while a local one is echoed even if a LATER gate then refuses the run.
    if ($TargetNetId -and ($LocalAmsNetIds -contains $TargetNetId)) {
        Write-Host ("Requested target:        {0}" -f $TargetNetId) -ForegroundColor Cyan
    }

    try {
        $ActivationTarget = Resolve-ActivationTarget -LocalNetIds $LocalAmsNetIds `
                                                     -RequestedNetId $TargetNetId `
                                                     -ProjectNetId $projTarget `
                                                     -Platform $PlatformName `
                                                     -TargetPlatforms $LocalTargetPlatforms `
                                                     -Configuration $ConfigName
    }
    catch {
        # The function indents its own continuation lines, so this one Write-Host prints the same
        # bytes the four inline refusals used to print line by line.
        Write-Host "FATAL: $_" -ForegroundColor Red
        exit 2
    }

    # What the build will be compared against, printed BEFORE the build rather than discovered after
    # it. An unknown platform says so: printing nothing there reads as "there was nothing to check".
    Write-Host ("Activation target:       {0}  ({1})" -f
        $ActivationTarget.TargetNetId, $ActivationTarget.TargetSource) -ForegroundColor Cyan
    Write-Host ("Target platform:         {0}" -f
        (Format-RuntimePlatform -Entry $LocalTargetPlatforms[$ActivationTarget.TargetNetId])) -ForegroundColor Cyan
    foreach ($w in $ActivationTarget.Warnings) { Write-Host "WARNING: $w" -ForegroundColor Yellow }
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

    # ------------------------------------------------------------------------------------------
    # Activation. Deliberately here: after the pass/fail decision, still inside the try, and BEFORE
    # the finally that closes the solution. The system manager only exists while the solution is
    # open, so there is no later point at which this could run - and no separate script could reach
    # it without re-opening everything.
    #
    # NOTE the naming trap: $slnConfigSelected / $cfg.Activate() earlier in this file is Visual
    # Studio's SolutionConfiguration.Activate - it merely picks 'Release|TwinCAT RT (x64)' in the
    # IDE. ITcSysManager::ActivateConfiguration below is the unrelated thing that deploys.
    # ------------------------------------------------------------------------------------------
    if ($ActivateConfiguration -and $failed -ne 0) {
        Write-Host "NOTE: activation skipped - the build failed." -ForegroundColor DarkGray
    }
    elseif ($ActivateConfiguration) {
        $activationFault = $null
        $uiWasSuppressed = $true
        try {
            # The system manager is the TwinCAT project's .Object. Identify it by CAPABILITY - the one
            # that answers LookupTreeItem('TIPC') - never by index: a solution may hold more than one
            # project. Measured 2026-07-29: reachable in ~2.5 s over this script's plain
            # New-Object -ComObject DTE, with no message pump and no message filter.
            $sysManager = $null
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline -and $null -eq $sysManager) {
                try {
                    foreach ($project in $dte.Solution.Projects) {
                        try {
                            $candidate = $project.Object
                            $null = $candidate.LookupTreeItem('TIPC')
                            $sysManager = $candidate
                            break
                        } catch { }
                    }
                } catch { }
                if ($null -eq $sysManager) { Start-Sleep -Milliseconds 500 }
            }
            if (-not $sysManager) { throw "no usable TwinCAT system manager on this solution" }

            $targetBefore = "$(Invoke-ComRetry { $sysManager.GetTargetNetId() })"
            Write-Host "Activation target (as opened): $targetBefore" -ForegroundColor Cyan

            # Force the target, even when it already reads correct: this is what stops the .tsproj,
            # the shell, or a user setting from supplying it. Then read it back - setting is not
            # guaranteed to take, exactly as with rm.Version.
            # -TargetNetId wins; otherwise keep whatever the solution opened with if it is local,
            # else fall back to the first local NetId.
            #
            # Resolve-ActivationTarget already made the pre-COM half of that choice (-TargetNetId, or
            # the first local NetId), so it is the seed rather than a second copy of the rule. The
            # live readback can still improve on it, and -TargetNetId is re-applied last because it
            # outranks the readback too.
            $pinTarget = $ActivationTarget.TargetNetId
            if ($LocalAmsNetIds -contains $targetBefore) { $pinTarget = $targetBefore }
            if ($TargetNetId) { $pinTarget = $TargetNetId }
            Invoke-ComRetry { $sysManager.SetTargetNetId($pinTarget) }
            $targetAfter = "$(Invoke-ComRetry { $sysManager.GetTargetNetId() })"

            if ($targetAfter -ne $pinTarget -or ($LocalAmsNetIds -notcontains $targetAfter)) {
                throw ("target readback is '$targetAfter', wanted a local one ('$pinTarget'). " +
                       "Refusing to activate against a target that cannot be confirmed local.")
            }
            Write-Host "Activation target:       $targetAfter  (local, confirmed by readback)" -ForegroundColor Cyan
            # Re-printed for $targetAfter, which the readback above is allowed to change: the platform
            # the XAE Shell is about to check is the one belonging to THIS target, not to the one the
            # pre-COM gate looked at.
            Write-Host ("Target platform:         {0}" -f
                (Format-RuntimePlatform -Entry $LocalTargetPlatforms[$targetAfter])) -ForegroundColor Cyan

            # Show the IDE for the activation. It can raise a licence prompt or a full-download
            # prompt, and under SuppressUI those are an invisible hang rather than a question.
            Write-Host "NOTE: the XAE Shell window is shown during activation - answer any dialog it raises." -ForegroundColor DarkGray
            try { Invoke-ComRetry { $dte.SuppressUI = $false }; $uiWasSuppressed = $false } catch { }
            try { Invoke-ComRetry { $dte.MainWindow.Visible = $true } } catch { }

            Write-Host "ACTIVATING CONFIGURATION (this stops and restarts the local TwinCAT runtime)..." -ForegroundColor Yellow
            Invoke-ComRetry { $sysManager.ActivateConfiguration() }
            Invoke-ComRetry { $sysManager.StartRestartTwinCAT() }

            # Verify via ADS, NOT via IsTwinCatStarted().
            #
            # Measured 2026-07-29: IsTwinCatStarted() returns a genuine Boolean $true while the
            # system is in CONFIG (ADS state 15). It reports that TwinCAT is up, not that it is
            # running, and an earlier version of this block reported "ACTIVATION SUCCEEDED" on a
            # machine that never left Config because of it. RUN is ADS state 5 and nothing else.
            $adsState = $null
            $deadline2 = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline2) {
                $adsState = Get-TcAdsState -NetId $pinTarget
                if ($adsState -eq 5) { break }
                Start-Sleep -Milliseconds 1000
            }
            $stateName = if ($null -ne $adsState) { $TcAdsStateNames[[int]$adsState] } else { 'unreadable' }

            if ($adsState -eq 5) {
                Write-Host "ACTIVATION SUCCEEDED. ($pinTarget is in RUN, ADS state 5)" -ForegroundColor Green
            }
            elseif ($null -eq $adsState) {
                # Could not read ADS at all. Do not claim success and do not claim failure - the
                # configuration was written, but whether it runs is genuinely unknown from here.
                Write-Host "ACTIVATION INCOMPLETE: configuration written, but the run state could not be read" -ForegroundColor Yellow
                Write-Host "                       from $pinTarget via ADS. Check the runtime yourself." -ForegroundColor Yellow
                $script:activationUnverified = $true
            }
            else {
                throw ("configuration was activated, but $pinTarget is in $stateName (ADS state $adsState), not RUN. " +
                       "On a machine where Hyper-V or VBS owns the cores the real-time runtime cannot start; " +
                       "a user-mode runtime target can.")
            }
        }
        catch { $activationFault = "$_" }
        finally {
            if (-not $uiWasSuppressed) { try { Invoke-ComRetry { $dte.SuppressUI = $true } } catch { } }
        }

        if ($activationFault) {
            Write-Host "ACTIVATION FAILED: $activationFault" -ForegroundColor Red
            # 3, not 1 or 2: the BUILD was fine. Collapsing this into "failed" would lose the one
            # distinction a caller most needs - whether the artifact is good and only the deploy went
            # wrong. Existing callers gate on -ne 0 and still see a failure.
            $exitCode = 3
        }
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
            # A swallowed failure here is invisible AND expensive: the shell survives, the next run
            # censuses it as somebody else's and refuses to touch it, and they accumulate one per
            # build. Report it instead, and confirm the process actually went away rather than
            # trusting the call - Quit() is asynchronous, so it is allowed a moment to take effect.
            $quitError = $null
            try { $dte.Quit() } catch { $quitError = $_ }
            $gone = $false
            for ($q = 0; $q -lt 20; $q++) {
                if (-not (Get-Process -Id $ownShellPid -ErrorAction SilentlyContinue)) { $gone = $true; break }
                Start-Sleep -Milliseconds 500
            }
            if (-not $gone) {
                Write-Host "WARNING: the XAE Shell we started (PID $ownShellPid) is still running after Quit()." -ForegroundColor Yellow
                if ($quitError) { Write-Host "         Quit() failed: $quitError" -ForegroundColor Yellow }
                Write-Host "         Close it yourself: Stop-Process -Id $ownShellPid" -ForegroundColor Yellow
            }
        } elseif (-not $ownShellPid) {
            Write-Host "NOTE: leaving the XAE Shell open - could not prove which process it is." -ForegroundColor DarkGray
        }

        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dte) | Out-Null
    }
    # Revoke last: the filter must outlive every COM call above, including Quit().
    if ($filterRegistered) { try { [TcBuildMessageFilter]::Revoke() } catch { } }
}
exit $exitCode
