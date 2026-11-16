<#
.SYNOPSIS
    Unit tests for the activation decisions in build_plc_project.ps1 - the gates, and the platform
    lookup they now depend on.

.DESCRIPTION
    Resolve-ActivationTarget is the COM-free half of the builder's activation handling: it decides
    which target an activation may use, and refuses every target it cannot prove belongs to THIS
    machine. Being pure is what makes it testable - it needs no TwinCAT installation, no XAE Shell, no
    solution and no network, and it never launches an IDE or touches a runtime.

    THESE TESTS ARE THE ONLY COVERAGE THOSE REFUSALS HAVE. The gates are correct by construction, but
    a refusal cannot be demonstrated end to end without a station that answers, and one that answers
    is exactly the thing that must never be activated onto by accident. So the refusals are pinned
    here instead: the messages, and - just as importantly - the ORDER they fire in, because which gate
    reports first is what tells a caller what to fix.

    The second half of this file pins how a target's PLATFORM is established, because getting that
    wrong is what made gate 4 refuse correct configurations: it used to come from the host CPU, which
    knows the architecture and cannot possibly know the runtime kind ('TwinCAT RT' is the real-time
    kernel, 'TwinCAT OS' a user-mode runtime, and one machine runs both). Those cases run against
    FIXTURE runtime folders written under the temp directory and deleted afterwards, so they assert the
    rule rather than whatever this particular machine happens to have installed.

    build_plc_project.ps1 BUILDS when it is run or dot-sourced, so the functions cannot simply be
    dot-sourced out of it. They are lifted from the file's real source text with the PowerShell parser
    instead, so the tests track the script rather than a copy.

    The NetIds below are synthetic placeholders drawn from the RFC 5737 documentation ranges
    (TEST-NET-1 192.0.2.0/24 and TEST-NET-2 198.51.100.0/24), never real machine addresses. They were
    chosen to preserve the shape relationships the tests exercise: 192.0.2.52.1.1 and 198.51.100.4.1.1
    stand in for a machine's real-time and user-mode runtimes, and 192.0.2.51.1.1 - sharing the
    real-time runtime's 192.0.2 network but a different host octet - stands in for a physical station
    on the same network that must never be reachable from here. They are literals here, never read
    from this host, so the expectations mean the same thing on every machine.

.PARAMETER ScriptPath
    The script under test. Defaults to build_plc_project.ps1 beside this file. (Resolved after the
    param block, not in it: $PSScriptRoot is not yet populated while parameter defaults are bound
    under `powershell -File`.)

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\test-activation-target.ps1

.NOTES
    Exit codes:  0  every case passed
                 1  at least one case failed
                 2  the harness itself could not run (script missing, parse error, function gone,
                    or a function whose signature no longer matches what these tests assert)
#>
[CmdletBinding()]
param(
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

function Fail-Harness {
    param([string]$Message)
    Write-Host "FATAL: $Message" -ForegroundColor Red
    exit 2
}

if (-not $ScriptPath) {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ScriptPath = Join-Path $here 'build_plc_project.ps1'
}

if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
    Fail-Harness "script under test not found: $ScriptPath"
}

$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Fail-Harness ("$ScriptPath has $($parseErrors.Count) parse error(s):`n" +
                  (($parseErrors | ForEach-Object { "  $_" }) -join "`n"))
}

# Returns the source text only - the dot-sourcing has to happen at SCRIPT scope, or the function
# lands in this helper's scope and vanishes when it returns.
function Get-FunctionText {
    param([string]$Name)
    $fnAst = $ast.Find({
        param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name
    }, $true)
    if (-not $fnAst) { Fail-Harness "no function $Name in $ScriptPath" }
    return $fnAst.Extent.Text
}

# The gate under test, plus the platform-resolution functions it is fed by. The latter read files, but
# only files these tests write themselves - no TwinCAT installation is involved.
. ([scriptblock]::Create((Get-FunctionText 'Resolve-ActivationTarget')))
. ([scriptblock]::Create((Get-FunctionText 'Resolve-RuntimePlatform')))
. ([scriptblock]::Create((Get-FunctionText 'Get-LocalRuntimePlatform')))
. ([scriptblock]::Create((Get-FunctionText 'Get-TcBootPlatform')))
. ([scriptblock]::Create((Get-FunctionText 'Get-TcRuntimeKind')))
. ([scriptblock]::Create((Get-FunctionText 'Get-UserModeRuntimeRecords')))
. ([scriptblock]::Create((Get-FunctionText 'Get-RuntimeLabels')))
. ([scriptblock]::Create((Get-FunctionText 'Resolve-UserModeNetIdTrust')))
. ([scriptblock]::Create((Get-FunctionText 'Confirm-UserModeNetIdTrust')))
. ([scriptblock]::Create((Get-FunctionText 'Get-UnknownRuntimeLabels')))

# A signature check, not a style check. The table below is written against -TargetPlatforms - a
# PER-TARGET map - and would be meaningless against a builder that still asks about the host, so say
# so rather than reporting green.
$gateParams = @((Get-Command Resolve-ActivationTarget -CommandType Function).Parameters.Keys)
foreach ($needed in 'LocalNetIds', 'RequestedNetId', 'ProjectNetId', 'Platform', 'TargetPlatforms',
                    'Configuration', 'RuntimeLabels', 'UnknownRuntimes') {
    if ($gateParams -notcontains $needed) {
        Fail-Harness "Resolve-ActivationTarget has no -$needed parameter; these tests are written against it."
    }
}
if ($gateParams -contains 'HostPlatform') {
    Fail-Harness ("Resolve-ActivationTarget still takes -HostPlatform. The host CPU cannot know a " +
                  "runtime's kind, so the platform is a property of the TARGET - these tests are " +
                  "written against -TargetPlatforms.")
}
if (@((Get-Command Get-LocalRuntimePlatform -CommandType Function).Parameters.Keys) -notcontains 'Kind') {
    Fail-Harness ("Get-LocalRuntimePlatform has no -Kind parameter. The host may supply the " +
                  "architecture and never the kind; a kind-less version is the original bug.")
}

$Rt64  = 'TwinCAT RT (x64)'
$Rt86  = 'TwinCAT RT (x86)'
$Os64  = 'TwinCAT OS (x64)'
$OsArm = 'TwinCAT OS (ARMV8-A)'

# This machine's two runtimes, and a station that is emphatically not this machine.
$NetRt     = '192.0.2.52.1.1'         # real-time runtime
$NetUm     = '198.51.100.4.1.1'       # user-mode runtime
$NetRemote = '192.0.2.51.1.1'         # a physical station - must never be reachable from here
$Both      = @($NetRt, $NetUm)

# Platform maps. The VALUES are what Get-LocalRuntimePlatforms hands the gate: $null for a platform
# that could not be established, else an object carrying the platform and how it was learned.
function New-PlatformEntry {
    param([string]$Platform, [string]$Provenance = 'read')
    return [pscustomobject]@{ Platform = $Platform; Provenance = $Provenance }
}
# Both runtimes on the same platform - the default for every case that is not about platforms.
$AllRt64  = @{ $NetRt = (New-PlatformEntry $Rt64); $NetUm = (New-PlatformEntry $Rt64) }
$AllRt86  = @{ $NetRt = (New-PlatformEntry $Rt86); $NetUm = (New-PlatformEntry $Rt86) }
# The real shape of a machine: a real-time runtime and a user-mode one, on DIFFERENT platforms, both
# read from their own boot configurations.
$Mixed     = @{ $NetRt = (New-PlatformEntry $Rt64); $NetUm = (New-PlatformEntry $Os64) }
# The same machine before the real-time runtime has ever been activated: nothing about it was read, so
# its kind comes from the absence of a usermode marker and its architecture from the host.
$RtGuessed = @{ $NetRt = (New-PlatformEntry $Rt64 'kind-inferred'); $NetUm = (New-PlatformEntry $Os64) }

$script:passed = 0
$script:failed = 0

function Write-Pass {
    param([string]$Name, [string]$Detail)
    $script:passed++
    Write-Host ("  PASS  " + $Name) -ForegroundColor Green
    if ($Detail) { Write-Host ("          " + $Detail) -ForegroundColor DarkGray }
}

function Write-Fail {
    param([string]$Name, [string]$Detail)
    $script:failed++
    Write-Host ("  FAIL  " + $Name) -ForegroundColor Red
    Write-Host ("          " + $Detail) -ForegroundColor Red
}

# One line of a thrown message, so a multi-line "FATAL:`r`n       Local: ..." stays readable.
function Format-Message {
    param([string]$Text)
    return (($Text -split "`r?`n" | ForEach-Object { $_.Trim() }) -join ' ')
}

function Test-Allows {
    param(
        [string]$Name,
        [string[]]$Local,
        [string]$Requested,
        [string]$Project,
        [string]$Platform,
        [hashtable]$TargetPlatforms,
        [string]$Configuration = 'Release',
        [string]$ExpectTarget,
        [string]$ExpectSource,
        [string]$ExpectPlatform,          # '' asserts "unknown"; only checked when passed
        [string[]]$ExpectWarning,         # substrings that must appear among the warnings
        [switch]$ExpectNoWarnings
    )
    if (-not $Platform) { $Platform = $Rt64 }
    # ContainsKey, not truthiness: -TargetPlatforms $null and @{} are both deliberate inputs here.
    if (-not $PSBoundParameters.ContainsKey('TargetPlatforms')) { $TargetPlatforms = $AllRt64 }
    try {
        $r = Resolve-ActivationTarget -LocalNetIds $Local -RequestedNetId $Requested `
                                      -ProjectNetId $Project -Platform $Platform `
                                      -TargetPlatforms $TargetPlatforms -Configuration $Configuration
    } catch {
        Write-Fail $Name ("refused unexpectedly: " + (Format-Message "$_"))
        return
    }

    $problems = @()
    if ($r.TargetNetId  -ne $ExpectTarget) { $problems += "TargetNetId '$($r.TargetNetId)' != '$ExpectTarget'" }
    if ($r.TargetSource -ne $ExpectSource) { $problems += "TargetSource '$($r.TargetSource)' != '$ExpectSource'" }
    # The chosen target must be one the caller actually offered - the whole safety property in one line.
    if (@($Local | Where-Object { $_ }) -notcontains $r.TargetNetId) {
        $problems += "TargetNetId '$($r.TargetNetId)' is not in the local set"
    }
    if ($PSBoundParameters.ContainsKey('ExpectPlatform') -and "$($r.TargetPlatform)" -ne $ExpectPlatform) {
        $problems += "TargetPlatform '$($r.TargetPlatform)' != '$ExpectPlatform'"
    }

    $warnText = (@($r.Warnings) -join ' | ')
    foreach ($w in @($ExpectWarning | Where-Object { $_ })) {
        if ($warnText -notlike "*$w*") { $problems += "no warning mentioning '$w' (warnings: '$warnText')" }
    }
    if ($ExpectNoWarnings -and @($r.Warnings).Count -gt 0) { $problems += "unexpected warning: $warnText" }

    if ($problems.Count -gt 0) {
        Write-Fail $Name ($problems -join '; ')
    } else {
        $detail = "target $($r.TargetNetId) ($($r.TargetSource))"
        if ($r.TargetPlatform) { $detail += ", platform $($r.TargetPlatform) [$($r.TargetProvenance)]" }
        else                   { $detail += ", platform unknown" }
        if ($warnText)         { $detail += " -- warned: $warnText" }
        Write-Pass $Name $detail
    }
}

function Test-Refuses {
    param(
        [string]$Name,
        [string[]]$Local,
        [string]$Requested,
        [string]$Project,
        [string]$Platform,
        [hashtable]$TargetPlatforms,
        [string]$Configuration = 'Release',
        [string[]]$MessageContains,
        [string[]]$MessageLacks,         # the gate that must NOT report - this is how precedence is pinned
        [hashtable]$RuntimeLabels,        # wording only: NetId -> label, as Get-RuntimeLabels builds it
        [string[]]$UnknownRuntimes        # wording only: as Get-UnknownRuntimeLabels builds it
    )
    if (-not $Platform) { $Platform = $Rt64 }
    if (-not $PSBoundParameters.ContainsKey('TargetPlatforms')) { $TargetPlatforms = $AllRt64 }
    try {
        $r = Resolve-ActivationTarget -LocalNetIds $Local -RequestedNetId $Requested `
                                      -ProjectNetId $Project -Platform $Platform `
                                      -TargetPlatforms $TargetPlatforms -Configuration $Configuration `
                                      -RuntimeLabels $RuntimeLabels -UnknownRuntimes $UnknownRuntimes
        Write-Fail $Name "did not refuse; returned target $($r.TargetNetId) ($($r.TargetSource))"
        return
    } catch {
        $msg      = "$_"
        $problems = @()
        # Blanks filtered FIRST: an omitted -MessageLacks binds as $null, and "*$null*" is "**",
        # which matches everything - every case would report a precedence violation.
        $missing  = @($MessageContains | Where-Object { $_ } | Where-Object { $msg -notlike "*$_*" })
        $present  = @($MessageLacks    | Where-Object { $_ } | Where-Object { $msg -like    "*$_*" })
        if ($missing.Count -gt 0) { $problems += "does not mention " + ($missing -join ', ') }
        if ($present.Count -gt 0) { $problems += "a later gate reported: " + ($present -join ', ') }
        if ($problems.Count -gt 0) {
            Write-Fail $Name (($problems -join '; ') + " -- got: " + (Format-Message $msg))
        } else {
            Write-Pass $Name ("refused: " + (Format-Message $msg))
        }
    }
}

# Plain equality for the platform-resolution half, where the answer is an object or $null.
function Test-Equals {
    param([string]$Name, $Actual, $Expected)
    if ("$Actual" -eq "$Expected") { Write-Pass $Name "= '$Actual'" }
    else                           { Write-Fail $Name "got '$Actual', expected '$Expected'" }
}

Write-Host "Resolve-ActivationTarget  (source: $ScriptPath)" -ForegroundColor Cyan
Write-Host "  local NetIds used by the table: $($Both -join ', ')   remote: $NetRemote" -ForegroundColor DarkGray
Write-Host "  platforms come from the -TargetPlatforms map below, never from this host" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------------- allowed
Test-Allows   -Name 'a requested NetId that is in the local set is used' `
              -Local $Both -Requested $NetRt `
              -ExpectTarget $NetRt -ExpectSource 'requested'

Test-Allows   -Name 'the other local runtime is equally acceptable (user-mode)' `
              -Local $Both -Requested $NetUm `
              -ExpectTarget $NetUm -ExpectSource 'requested'

Test-Allows   -Name 'nothing requested, nothing in the project: the first local NetId' `
              -Local $Both `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

Test-Allows   -Name 'an empty -RequestedNetId counts as not requested' `
              -Local $Both -Requested '' `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

Test-Allows   -Name 'a $null -RequestedNetId counts as not requested' `
              -Local $Both -Requested $null `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

Test-Allows   -Name 'a solution legitimately targeting this machine is allowed' `
              -Local $Both -Project $NetUm `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

Test-Allows   -Name 'a local project target does not override -TargetNetId' `
              -Local $Both -Requested $NetUm -Project $NetRt `
              -ExpectTarget $NetUm -ExpectSource 'requested'

Test-Allows   -Name 'blanks in the local set are dropped, not counted' `
              -Local @($null, '', $NetUm) -Requested $NetUm `
              -ExpectTarget $NetUm -ExpectSource 'requested'

# ---------------------------------------------------------------------------- gate 4: known platforms
Test-Allows   -Name "the chosen target's own platform is what -Platform is checked against" `
              -Local $Both -Platform $Rt64 -TargetPlatforms $AllRt64 `
              -ExpectTarget $NetRt -ExpectSource 'first-local' -ExpectPlatform $Rt64 -ExpectNoWarnings

Test-Allows   -Name 'the gate is target-relative, not host-relative: an x86 target takes an x86 build' `
              -Local $Both -Platform $Rt86 -TargetPlatforms $AllRt86 `
              -ExpectTarget $NetRt -ExpectSource 'first-local' -ExpectPlatform $Rt86 -ExpectNoWarnings

Test-Allows   -Name 'platform comparison is case-insensitive (-ne, not a byte compare)' `
              -Local $Both -Platform 'twincat rt (x64)' -TargetPlatforms $AllRt64 `
              -ExpectTarget $NetRt -ExpectSource 'first-local' -ExpectNoWarnings

Test-Allows   -Name 'THE BUG: a TwinCAT OS build onto a user-mode runtime that runs TwinCAT OS' `
              -Local $Both -Requested $NetUm -Platform $Os64 -TargetPlatforms $Mixed `
              -ExpectTarget $NetUm -ExpectSource 'requested' -ExpectPlatform $Os64 -ExpectNoWarnings

Test-Allows   -Name 'a bare platform string in the map is accepted as well as an object' `
              -Local $Both -Requested $NetUm -Platform $Os64 -TargetPlatforms @{ $NetUm = $Os64 } `
              -ExpectTarget $NetUm -ExpectSource 'requested' -ExpectPlatform $Os64 -ExpectNoWarnings

Test-Refuses  -Name 'a platform the chosen target does not run is refused, naming both and the target' `
              -Local $Both -Platform $Rt86 -TargetPlatforms $AllRt64 `
              -MessageContains @($Rt86, $Rt64, $NetRt, 'is not the platform of activation target',
                                 "Release|$Rt64")

Test-Refuses  -Name 'the platform refusal suggests the actual -Configuration, not a hardcoded one' `
              -Local $Both -Platform $OsArm -TargetPlatforms $AllRt64 -Configuration 'Debug' `
              -MessageContains @($OsArm, "Debug|$Rt64")

Test-Refuses  -Name 'no exemption: a perfect local target does not excuse a foreign platform' `
              -Local $Both -Requested $NetUm -Project $NetUm -Platform $Rt86 -TargetPlatforms $AllRt64 `
              -MessageContains @('is not the platform of activation target')

Test-Refuses  -Name '-TargetNetId selects WHICH platform is compared: the real-time one refuses an OS build' `
              -Local $Both -Requested $NetRt -Platform $Os64 -TargetPlatforms $Mixed `
              -MessageContains @($NetRt, $Rt64, $Os64, "Release|$Rt64")

Test-Refuses  -Name 'without -TargetNetId the platform gate follows the first local NetId' `
              -Local $Both -Platform $Os64 -TargetPlatforms $Mixed `
              -MessageContains @($NetRt, $Rt64)

Test-Refuses  -Name 'an unknown platform elsewhere does not excuse a mismatch on the chosen target' `
              -Local $Both -Requested $NetUm -Platform $Rt64 `
              -TargetPlatforms @{ $NetRt = $null; $NetUm = (New-PlatformEntry $Os64) } `
              -MessageContains @($NetUm, $Os64)

Test-Refuses  -Name 'an INFERRED platform still refuses, and the refusal says it was inferred' `
              -Local $Both -Requested $NetRt -Platform $Os64 -TargetPlatforms $RtGuessed `
              -MessageContains @($NetRt, $Rt64, $Os64, 'inferred')

Test-Allows   -Name 'an inferred platform that matches is allowed, and is reported as inferred' `
              -Local $Both -Requested $NetRt -Platform $Rt64 -TargetPlatforms $RtGuessed `
              -ExpectTarget $NetRt -ExpectSource 'requested' -ExpectPlatform $Rt64 -ExpectNoWarnings

# ---------------------------------------------------------------------------- gate 4: unknown platforms
# Unknown ALLOWS. Refusing on a guess is what made a correct configuration impossible to activate;
# the XAE Shell performs this check itself and reports it accurately.
$UnknownWarning = 'could not be established'

Test-Allows   -Name 'an unknown platform is allowed, and warned about rather than guessed' `
              -Local $Both -Platform $Os64 -TargetPlatforms @{} `
              -ExpectTarget $NetRt -ExpectSource 'first-local' -ExpectPlatform '' `
              -ExpectWarning @($UnknownWarning, $NetRt, $Os64)

Test-Allows   -Name 'a $null map is unknown, not a refusal' `
              -Local $Both -Platform $OsArm -TargetPlatforms $null `
              -ExpectTarget $NetRt -ExpectSource 'first-local' -ExpectPlatform '' `
              -ExpectWarning @($UnknownWarning)

Test-Allows   -Name 'a map that knows OTHER runtimes but not the chosen one is still unknown' `
              -Local $Both -Requested $NetRt -Platform $OsArm `
              -TargetPlatforms @{ $NetUm = (New-PlatformEntry $Os64); $NetRemote = (New-PlatformEntry $Rt86) } `
              -ExpectTarget $NetRt -ExpectSource 'requested' -ExpectPlatform '' `
              -ExpectWarning @($UnknownWarning, $NetRt)

Test-Allows   -Name 'a NetId present in the map with no platform is unknown, not a mismatch' `
              -Local $Both -Requested $NetRt -Platform $Os64 `
              -TargetPlatforms @{ $NetRt = $null; $NetUm = (New-PlatformEntry $Os64) } `
              -ExpectTarget $NetRt -ExpectSource 'requested' -ExpectPlatform '' `
              -ExpectWarning @($UnknownWarning, $NetRt)

Test-Allows   -Name 'an empty platform string is unknown too, not a platform named ""' `
              -Local $Both -Requested $NetUm -Platform $Os64 -TargetPlatforms @{ $NetUm = '' } `
              -ExpectTarget $NetUm -ExpectSource 'requested' -ExpectPlatform '' `
              -ExpectWarning @($UnknownWarning)

# ---------------------------------------------------------------------------- refused
Test-Refuses  -Name 'an empty local set is refused: nothing can be proven local' `
              -Local @() `
              -MessageContains @("cannot determine this machine's AmsNetId", 'Refusing to activate')

Test-Refuses  -Name 'a $null local set is refused the same way' `
              -Local $null `
              -MessageContains @("cannot determine this machine's AmsNetId")

Test-Refuses  -Name 'a local set of nothing but blanks is an empty set' `
              -Local @($null, '') `
              -MessageContains @("cannot determine this machine's AmsNetId")

Test-Refuses  -Name 'a requested NetId outside the local set is refused, and the set is named' `
              -Local $Both -Requested $NetRemote `
              -MessageContains @('-TargetNetId', $NetRemote, $NetRt, $NetUm, 'local-only')

Test-Refuses  -Name 'a named remote station is refused with the not-an-AmsNetId-of-this-machine wording' `
              -Local $Both -Requested '192.0.2.51.1.1' `
              -MessageContains @('192.0.2.51.1.1', 'is not an AmsNetId of this machine')

Test-Refuses  -Name 'a project .tsproj target that is not local is refused with NO -TargetNetId' `
              -Local $Both -Project $NetRemote `
              -MessageContains @('this solution names TargetNetId', $NetRemote, 'no override')

Test-Refuses  -Name 'a local -TargetNetId does not excuse a remote project target' `
              -Local $Both -Requested $NetUm -Project $NetRemote `
              -MessageContains @('this solution names TargetNetId', $NetRemote)

# The project refusal names the way past it: every local runtime, labelled where a label is known.
$Labels = @{ $NetRt = 'real-time runtime'; $NetUm = 'UmRT_Default, user-mode runtime' }

Test-Refuses  -Name 'the project refusal says "not a runtime on this PC" and names every local runtime' `
              -Local $Both -Project $NetRemote `
              -MessageContains @('not a runtime on this PC', "Runtimes on this PC: $NetRt, $NetUm",
                                 'Choose Target System', 'no override')

Test-Refuses  -Name 'the project refusal labels each local runtime when labels are given' `
              -Local $Both -Project $NetRemote -RuntimeLabels $Labels `
              -MessageContains @("$NetRt (real-time runtime)", "$NetUm (UmRT_Default, user-mode runtime)")

Test-Refuses  -Name 'a runtime without a label is still named, bare' `
              -Local $Both -Project $NetRemote -RuntimeLabels @{ $NetUm = 'UmRT_Default, user-mode runtime' } `
              -MessageContains @("Runtimes on this PC: $NetRt, $NetUm (UmRT_Default, user-mode runtime)")

Test-Refuses  -Name 'labels change no decision: a local -TargetNetId still does not excuse a remote project target' `
              -Local $Both -Requested $NetUm -Project $NetRemote -RuntimeLabels $Labels `
              -MessageContains @('this solution names TargetNetId', $NetRemote, 'not a runtime on this PC')

Test-Allows   -Name 'labels change no decision: a local project target is allowed' `
              -Local $Both -Project $NetUm `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

# Get-RuntimeLabels: pure over the records it is handed.
$labelRecords = @(
    [pscustomobject]@{ NetId = $NetRt; Kind = 'real-time'; Source = 'HKLM:\SOFTWARE\Beckhoff\TwinCAT3\System' },
    [pscustomobject]@{ NetId = $NetUm; Kind = 'user-mode'; Source = 'C:\ProgramData\Beckhoff\TwinCAT\3.1\Runtimes\UmRT_Default' },
    [pscustomobject]@{ NetId = $NetUm; Kind = 'user-mode'; Source = 'C:\ProgramData\Beckhoff\TwinCAT\3.1\Runtimes\Second' },
    [pscustomobject]@{ NetId = ''; Kind = 'user-mode'; Source = 'C:\x' },
    $null
)
$got = Get-RuntimeLabels -Records $labelRecords
$labelProblems = @()
if ($got.Count -ne 2) { $labelProblems += "expected 2 labels, got $($got.Count)" }
if ($got[$NetRt] -ne 'real-time runtime') { $labelProblems += "real-time label '$($got[$NetRt])'" }
if ($got[$NetUm] -ne 'UmRT_Default, user-mode runtime') { $labelProblems += "user-mode label '$($got[$NetUm])' (the first record must win)" }
if ($labelProblems.Count -gt 0) { Write-Fail 'Get-RuntimeLabels names each NetId once, by kind and runtime folder' ($labelProblems -join '; ') }
else { Write-Pass 'Get-RuntimeLabels names each NetId once, by kind and runtime folder' (($got.Keys | Sort-Object | ForEach-Object { "$_ = $($got[$_])" }) -join '; ') }
if ((Get-RuntimeLabels -Records @()).Count -eq 0 -and (Get-RuntimeLabels -Records $null).Count -eq 0) {
    Write-Pass 'Get-RuntimeLabels of no records is an empty map' ''
} else {
    Write-Fail 'Get-RuntimeLabels of no records is an empty map' 'not empty'
}

# ---------------------------------------------------------------------------- user-mode NetId trust
# Resolve-UserModeNetIdTrust: pure over the process list and the file time it is handed. The times
# reproduce the user's 4026 machine (2026-11-16): the running instance started 11:46:38, a second
# instance of the same runtime rewrote TcRegistry.xml at 12:01:05 and closed again.
function New-UmProcess {
    param([string]$CommandLine, $StartTime)
    return [pscustomobject]@{ ProcessId = 1; CommandLine = $CommandLine; StartTime = $StartTime }
}
function Get-UtcTime { param([string]$Text) return [datetime]::SpecifyKind([datetime]::Parse($Text, [Globalization.CultureInfo]::InvariantCulture), 'Utc') }
$UmExe     = '"C:\Program Files (x86)\Beckhoff\TwinCAT\3.1\Runtimes\bin\TcSystemServiceUm.exe"'
$UmCmd     = "$UmExe -t bin -i path -n `"UmRT_Default`" -c .\3.1"
$UmStart   = Get-UtcTime '2026-11-16 11:46:38'
$UmRunning = @(New-UmProcess -CommandLine $UmCmd -StartTime $UmStart)

function Test-Trust {
    param([string]$Name, [string]$Runtime = 'UmRT_Default', $FileTime, $Processes, [switch]$ProcessListFailed,
          [string]$ExpectStatus, [string]$ReasonContains, [int]$ExpectInstances = -1)
    $t = Resolve-UserModeNetIdTrust -Name $Runtime -RegistryWriteTime $FileTime -Processes $Processes -ProcessListFailed:$ProcessListFailed
    $problems = @()
    if ($t.Status -ne $ExpectStatus) { $problems += "Status '$($t.Status)' != '$ExpectStatus'" }
    if ($ReasonContains -and "$($t.Reason)" -notlike "*$ReasonContains*") { $problems += "Reason '$($t.Reason)' lacks '$ReasonContains'" }
    if ($ExpectStatus -eq 'trusted' -and $t.Reason) { $problems += "a trusted NetId carries a reason: '$($t.Reason)'" }
    if ($ExpectInstances -ge 0 -and $t.Instances -ne $ExpectInstances) { $problems += "Instances $($t.Instances) != $ExpectInstances" }
    if ($problems.Count -gt 0) { Write-Fail $Name ($problems -join '; ') }
    else { Write-Pass $Name "$($t.Status)$(if ($t.Reason) { ': ' + $t.Reason })" }
}

Test-Trust -Name 'THE MEASURED CASE: the file was rewritten 15 min after the running instance started' `
           -FileTime (Get-UtcTime '2026-11-16 12:01:05') -Processes $UmRunning `
           -ExpectStatus 'rewritten' -ReasonContains 'the configuration file changed after this runtime started'
Test-Trust -Name 'the instance writes the file just after it starts: trusted' `
           -FileTime $UmStart.AddSeconds(2) -Processes $UmRunning -ExpectStatus 'trusted' -ExpectInstances 1
Test-Trust -Name 'a file older than the start is trusted (the instance did not rewrite it)' `
           -FileTime $UmStart.AddDays(-3) -Processes $UmRunning -ExpectStatus 'trusted'
Test-Trust -Name 'the tolerance is 5 s: a write at start + 5 s is still the instance' `
           -FileTime $UmStart.AddSeconds(5) -Processes $UmRunning -ExpectStatus 'trusted'
Test-Trust -Name 'and a write at start + 6 s is not' `
           -FileTime $UmStart.AddSeconds(6) -Processes $UmRunning -ExpectStatus 'rewritten'
Test-Trust -Name 'no process at all: not running' `
           -FileTime $UmStart -Processes @() -ExpectStatus 'not-running' -ReasonContains 'this runtime is not running'
Test-Trust -Name 'no process list (null): not running, fail closed' `
           -FileTime $UmStart -Processes $null -ExpectStatus 'not-running'
Test-Trust -Name 'a process for ANOTHER runtime does not make this one running' `
           -Runtime 'UmRT_Second' -FileTime $UmStart -Processes $UmRunning -ExpectStatus 'not-running'
Test-Trust -Name 'the name must match exactly: UmRT_Default2 is not UmRT_Default' `
           -FileTime $UmStart -Processes @(New-UmProcess -CommandLine "$UmExe -n `"UmRT_Default2`" -c .\3.1" -StartTime $UmStart) `
           -ExpectStatus 'not-running'
Test-Trust -Name 'the name is compared case-insensitively, and -n may be unquoted' `
           -FileTime $UmStart -Processes @(New-UmProcess -CommandLine "$UmExe -t bin -n umrt_default -c .\3.1" -StartTime $UmStart) `
           -ExpectStatus 'trusted'
Test-Trust -Name "an executable path containing ' -n UmRT_Default' is not the -n argument" `
           -FileTime $UmStart -Processes @(New-UmProcess -CommandLine '"C:\x -n UmRT_Default\TcSystemServiceUm.exe" -n "Other"' -StartTime $UmStart) `
           -ExpectStatus 'not-running'
Test-Trust -Name 'two instances: a file written by the newest is trusted' `
           -FileTime $UmStart.AddMinutes(10).AddSeconds(1) `
           -Processes @($UmRunning[0], (New-UmProcess -CommandLine $UmCmd -StartTime $UmStart.AddMinutes(10))) `
           -ExpectStatus 'trusted' -ExpectInstances 2
Test-Trust -Name 'two instances: a file written after the newest started is not' `
           -FileTime $UmStart.AddMinutes(20) `
           -Processes @($UmRunning[0], (New-UmProcess -CommandLine $UmCmd -StartTime $UmStart.AddMinutes(10))) `
           -ExpectStatus 'rewritten' -ExpectInstances 2
Test-Trust -Name 'a local start time compares with a UTC file time as the same instant' `
           -FileTime $UmStart.AddSeconds(2) -Processes @(New-UmProcess -CommandLine $UmCmd -StartTime $UmStart.ToLocalTime()) `
           -ExpectStatus 'trusted'
Test-Trust -Name 'an unreadable command line (elevated process) is unverifiable, not running' `
           -FileTime $UmStart -Processes @(New-UmProcess -CommandLine '' -StartTime $UmStart) `
           -ExpectStatus 'unverifiable' -ReasonContains 'command line could not be read'
Test-Trust -Name 'a process list that could not be read is unverifiable' `
           -FileTime $UmStart -Processes @() -ProcessListFailed -ExpectStatus 'unverifiable' -ReasonContains 'could not be listed'
Test-Trust -Name "an unreadable start time is unverifiable" `
           -FileTime $UmStart -Processes @(New-UmProcess -CommandLine $UmCmd -StartTime $null) -ExpectStatus 'unverifiable'
Test-Trust -Name "an unreadable file time is unverifiable" `
           -FileTime $null -Processes $UmRunning -ExpectStatus 'unverifiable'

# Confirm-UserModeNetIdTrust: a 'rewritten' or 'unverifiable' decision is confirmed over ADS through
# the injected probe. THE MEASURED CASE (2026-11-16): the only running instance, started 16:49:08,
# rewrote its own file at 16:50:40 during an activation; its runtime answers at the file's NetId.
$script:probeCalls = 0
$ProbeAnswers  = { param($n) $script:probeCalls++; [pscustomobject]@{ AdsState = 5; StateName = 'RUN'; AdsErrorCode = $null; DllProblem = $null; Error = $null } }
$ProbeNoTarget = { param($n) $script:probeCalls++; [pscustomobject]@{ AdsState = $null; AdsErrorCode = 7; DllProblem = $null; Error = $null } }
$ProbeNoPort   = { param($n) $script:probeCalls++; [pscustomobject]@{ AdsState = $null; AdsErrorCode = 6; DllProblem = $null; Error = $null } }
$ProbeNoDll    = { param($n) $script:probeCalls++; [pscustomobject]@{ AdsState = $null; AdsErrorCode = $null; DllProblem = "TwinCAT's ADS DLL (TcAdsDll.dll) was not found in X"; Error = $null } }
$ProbeInvalid  = { param($n) $script:probeCalls++; [pscustomobject]@{ AdsState = 0; AdsErrorCode = $null; DllProblem = $null; Error = $null } }
$ProbeThrows   = { param($n) $script:probeCalls++; throw 'boom' }
$ConfirmNet    = '10.0.0.4.1.1'
$RewrittenRun  = @(New-UmProcess -CommandLine $UmCmd -StartTime (Get-UtcTime '2026-11-16 16:49:08'))

function Test-Confirm {
    param([string]$Name, $Trust, [scriptblock]$Probe, [string]$NetId = $ConfirmNet,
          [string]$ExpectStatus, $ExpectSource, [string[]]$ReasonContains = @(), [int]$ExpectCalls)
    $script:probeCalls = 0
    $c = Confirm-UserModeNetIdTrust -Trust $Trust -NetId $NetId -ConfirmNetId $Probe
    $problems = @()
    if ($c.Status -ne $ExpectStatus) { $problems += "Status '$($c.Status)' != '$ExpectStatus'" }
    if ("$($c.Source)" -ne "$ExpectSource") { $problems += "Source '$($c.Source)' != '$ExpectSource'" }
    foreach ($s in $ReasonContains) { if ("$($c.Reason)" -notlike "*$s*") { $problems += "Reason '$($c.Reason)' lacks '$s'" } }
    if ($script:probeCalls -ne $ExpectCalls) { $problems += "probe called $($script:probeCalls) times, expected $ExpectCalls" }
    if ($c.Instances -ne $Trust.Instances) { $problems += "Instances $($c.Instances) != $($Trust.Instances)" }
    if ($problems.Count -gt 0) { Write-Fail $Name ($problems -join '; ') }
    else { Write-Pass $Name "$($c.Status)/$($c.Source)$(if ($c.Reason) { ': ' + $c.Reason })" }
}

$tRewritten = Resolve-UserModeNetIdTrust -Name 'UmRT_Default' -RegistryWriteTime (Get-UtcTime '2026-11-16 16:50:40') -Processes $RewrittenRun
Test-Equals -Name 'THE MEASURED CASE: an own rewrite 92 s after the start is rewritten by the times alone' -Actual $tRewritten.Status -Expected 'rewritten'
Test-Confirm -Name 'THE MEASURED CASE: the runtime answers over ADS, so the NetId is trusted via ads' `
             -Trust $tRewritten -Probe $ProbeAnswers -ExpectStatus 'trusted' -ExpectSource 'ads' -ExpectCalls 1 `
             -ReasonContains @('changed after this runtime started', "confirmed over ADS (the runtime answered at $ConfirmNet, state RUN)")
Test-Confirm -Name 'no runtime at the NetId (ADS error 7): stays rewritten, the outcome appended' `
             -Trust $tRewritten -Probe $ProbeNoTarget -ExpectStatus 'rewritten' -ExpectSource $null -ExpectCalls 1 `
             -ReasonContains @('changed after this runtime started', "could not be confirmed over ADS: no runtime answered at $ConfirmNet (ADS error 0x7)")
Test-Confirm -Name 'no system service port (ADS error 6): stays rewritten' `
             -Trust $tRewritten -Probe $ProbeNoPort -ExpectStatus 'rewritten' -ExpectSource $null -ExpectCalls 1 -ReasonContains @('(ADS error 0x6)')
Test-Confirm -Name 'no ADS DLL: stays rewritten, saying the DLL was not found' `
             -Trust $tRewritten -Probe $ProbeNoDll -ExpectStatus 'rewritten' -ExpectSource $null -ExpectCalls 1 -ReasonContains @("ADS DLL (TcAdsDll.dll) was not found")
Test-Confirm -Name 'an answer with AdsState 0 (Invalid) does not trust' `
             -Trust $tRewritten -Probe $ProbeInvalid -ExpectStatus 'rewritten' -ExpectSource $null -ExpectCalls 1 -ReasonContains @('no valid state')
Test-Confirm -Name 'a probe that throws does not trust' `
             -Trust $tRewritten -Probe $ProbeThrows -ExpectStatus 'rewritten' -ExpectSource $null -ExpectCalls 1 -ReasonContains @('failed: boom')
$tUnverifiable = Resolve-UserModeNetIdTrust -Name 'UmRT_Default' -RegistryWriteTime $UmStart -Processes @(New-UmProcess -CommandLine '' -StartTime $UmStart)
Test-Confirm -Name 'unverifiable (elevated process) is confirmed over ADS too' `
             -Trust $tUnverifiable -Probe $ProbeAnswers -ExpectStatus 'trusted' -ExpectSource 'ads' -ExpectCalls 1 -ReasonContains @('command line could not be read', 'confirmed over ADS')
Test-Confirm -Name 'unverifiable and no answer stays unverifiable' `
             -Trust $tUnverifiable -Probe $ProbeNoTarget -ExpectStatus 'unverifiable' -ExpectSource $null -ExpectCalls 1 -ReasonContains @('(ADS error 0x7)')
$tNotRunning = Resolve-UserModeNetIdTrust -Name 'UmRT_Default' -RegistryWriteTime $UmStart -Processes @()
Test-Confirm -Name 'not-running is NEVER probed, even by a probe that would answer' `
             -Trust $tNotRunning -Probe $ProbeAnswers -ExpectStatus 'not-running' -ExpectSource $null -ExpectCalls 0 -ReasonContains @('this runtime is not running')
$tTrusted = Resolve-UserModeNetIdTrust -Name 'UmRT_Default' -RegistryWriteTime $UmStart.AddSeconds(2) -Processes $UmRunning
Test-Confirm -Name 'trusted by the file times is not probed (no ADS on the happy path), source file-time' `
             -Trust $tTrusted -Probe $ProbeNoTarget -ExpectStatus 'trusted' -ExpectSource 'file-time' -ExpectCalls 0
Test-Confirm -Name 'without a probe the decision is unchanged' `
             -Trust $tRewritten -Probe $null -ExpectStatus 'rewritten' -ExpectSource $null -ExpectCalls 0 -ReasonContains @('changed after this runtime started')

# Get-UnknownRuntimeLabels: one line per runtime whose NetId is unknown; known ones are skipped.
$unknownRecords = @(
    [pscustomobject]@{ NetId = $NetRt; Kind = 'real-time'; Source = 'HKLM:\SOFTWARE\Beckhoff\TwinCAT3\System' },
    [pscustomobject]@{ NetId = $NetUm; Kind = 'user-mode'; Name = 'UmRT_Good'; NetIdStatus = 'trusted'; NetIdReason = '' },
    [pscustomobject]@{ NetId = $null; FileNetId = '198.51.100.6.1.1'; Kind = 'user-mode'; Name = 'UmRT_Default'
                       NetIdStatus = 'rewritten'; NetIdReason = 'the configuration file changed after this runtime started' },
    [pscustomobject]@{ NetId = $null; FileNetId = '198.51.100.6.1.1'; Kind = 'user-mode'; Name = 'UmRT_Default'
                       NetIdStatus = 'rewritten'; NetIdReason = 'twice' },
    $null
)
$unknownLines = @(Get-UnknownRuntimeLabels -Records $unknownRecords)
Test-Equals -Name 'Get-UnknownRuntimeLabels names each unknown runtime once, with its reason' `
            -Actual ($unknownLines -join ' | ') `
            -Expected 'UmRT_Default (user-mode runtime, AmsNetId unknown: the configuration file changed after this runtime started)'
Test-Equals -Name 'Get-UnknownRuntimeLabels of no records is empty' -Actual (@(Get-UnknownRuntimeLabels -Records $null).Count) -Expected 0

# The gates: an unknown runtime is never local - the refusal names it, and the local set is unchanged.
Test-Refuses -Name 'the stale file NetId as the project target is refused, and the unknown runtime is named' `
             -Local @($NetRt) -Project '198.51.100.6.1.1' -UnknownRuntimes $unknownLines `
             -MessageContains @('not a runtime on this PC', "Runtimes on this PC: $NetRt", 'Not offered, AmsNetId unknown: UmRT_Default',
                                'changed after this runtime started', "console window ('AmsNetId: ...')", 'Choose Target System')
Test-Refuses -Name 'no known runtime at all: gate 1, naming the unknown one' `
             -Local @() -Project '198.51.100.6.1.1' -UnknownRuntimes $unknownLines `
             -MessageContains @("cannot determine this machine's AmsNetId", 'Not offered, AmsNetId unknown: UmRT_Default')
Test-Refuses -Name 'a -TargetNetId naming the stale file NetId is not local (gate 2)' `
             -Local @($NetRt) -Requested '198.51.100.6.1.1' -UnknownRuntimes $unknownLines `
             -MessageContains @('-TargetNetId 198.51.100.6.1.1 is not an AmsNetId of this machine', 'Not offered, AmsNetId unknown')
Test-Refuses -Name 'without unknown runtimes the refusal has no "Not offered" line' `
             -Local @($NetRt) -Project $NetRemote -MessageContains @('not a runtime on this PC') -MessageLacks @('Not offered')

# ---------------------------------------------------------------------------- precedence
Test-Refuses  -Name 'precedence: an undetermined local set outranks every other gate' `
              -Local @() -Requested $NetRemote -Project $NetRemote -Platform $Rt86 -TargetPlatforms $AllRt64 `
              -MessageContains @("cannot determine this machine's AmsNetId") `
              -MessageLacks    @('-TargetNetId', 'this solution names', 'is not the platform of activation target')

Test-Refuses  -Name 'precedence: -TargetNetId outranks the project target' `
              -Local $Both -Requested $NetRemote -Project $NetRemote `
              -MessageContains @('-TargetNetId') `
              -MessageLacks    @('this solution names')

Test-Refuses  -Name 'precedence: -TargetNetId outranks the platform gate' `
              -Local $Both -Requested $NetRemote -Platform $Rt86 -TargetPlatforms $AllRt64 `
              -MessageContains @('-TargetNetId') `
              -MessageLacks    @('is not the platform of activation target')

Test-Refuses  -Name 'precedence: the project target outranks the platform gate' `
              -Local $Both -Project $NetRemote -Platform $Rt86 -TargetPlatforms $AllRt64 `
              -MessageContains @('this solution names TargetNetId') `
              -MessageLacks    @('is not the platform of activation target')

# ---------------------------------------------------------------------------- degenerate input
# These document the real behaviour rather than asserting a wish. Membership in the measured local
# set is the ENTIRE test: there is no syntactic validation and no trimming, so anything that is not
# character-for-character a local NetId is refused - which is the safe direction to be wrong in.
Test-Refuses  -Name 'a whitespace-only -TargetNetId is refused, not ignored' `
              -Local $Both -Requested '   ' `
              -MessageContains @('is not an AmsNetId of this machine')

Test-Refuses  -Name 'a local NetId with stray whitespace is not trimmed into a match' `
              -Local $Both -Requested " $NetUm " `
              -MessageContains @('is not an AmsNetId of this machine')

Test-Refuses  -Name 'a NetId with the wrong octet count is refused by membership, not by format' `
              -Local $Both -Requested '192.0.2.52' `
              -MessageContains @('192.0.2.52', 'is not an AmsNetId of this machine')

Test-Refuses  -Name 'a six-octet lookalike of a local NetId is still not that NetId' `
              -Local $Both -Requested '192.0.2.52.1.2' `
              -MessageContains @('192.0.2.52.1.2', 'is not an AmsNetId of this machine')

Test-Refuses  -Name 'a whitespace-only project target is refused, not ignored' `
              -Local $Both -Project '   ' `
              -MessageContains @('this solution names TargetNetId')

Test-Allows   -Name 'an empty project target counts as no project target' `
              -Local $Both -Project '' `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

Test-Allows   -Name 'a $null project target counts as no project target' `
              -Local $Both -Project $null `
              -ExpectTarget $NetRt -ExpectSource 'first-local'

Test-Allows   -Name 'a single-runtime machine is served by its only NetId' `
              -Local @($NetUm) -TargetPlatforms @{ $NetUm = (New-PlatformEntry $Rt64) } `
              -ExpectTarget $NetUm -ExpectSource 'first-local'

# ============================================================================
# How a target's platform is established.
#
# A platform string is a KIND plus an ARCHITECTURE. The host knows the architecture and cannot know
# the kind, and answering both from the host is what refused a correct 'TwinCAT OS (x64)' activation
# while demanding 'TwinCAT RT (x64)'. These cases pin the split, and the precedence between a value
# READ from a runtime's boot configuration and one assembled from a read kind plus this host's
# architecture.
# ============================================================================
Write-Host ""
Write-Host "Platform resolution  (Resolve-RuntimePlatform, Get-TcRuntimeKind, fixture runtimes)" -ForegroundColor Cyan

# Not read from the builder: computed here, so a wrong answer in Get-LocalRuntimePlatform is a failure
# rather than a tautology.
$HostArch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$HostRt    = "TwinCAT RT ($HostArch)"
$HostOs    = "TwinCAT OS ($HostArch)"
Write-Host "  this host contributes the architecture only: ($HostArch)" -ForegroundColor DarkGray
Write-Host ""

Test-Equals   -Name 'the host supplies the architecture for a kind the caller established' `
              -Actual (Get-LocalRuntimePlatform -Kind 'TwinCAT OS') -Expected $HostOs

Test-Equals   -Name "the default kind is the real-time runtime's, which is what it is a fallback for" `
              -Actual (Get-LocalRuntimePlatform) -Expected $HostRt

$readWins = Resolve-RuntimePlatform -BootPlatform $OsArm -KindPlatform $HostOs -KindSource 'read'
Test-Equals   -Name 'a boot configuration wins outright over an assembled platform' `
              -Actual $readWins.Platform -Expected $OsArm
Test-Equals   -Name 'and is the only provenance called "read"' `
              -Actual $readWins.Provenance -Expected 'read'

$archInferred = Resolve-RuntimePlatform -KindPlatform $HostOs -KindSource 'read'
Test-Equals   -Name 'a read kind plus this host: platform assembled' `
              -Actual $archInferred.Platform -Expected $HostOs
Test-Equals   -Name 'a read kind plus this host: provenance names the inferred half' `
              -Actual $archInferred.Provenance -Expected 'architecture-inferred'

$kindInferred = Resolve-RuntimePlatform -KindPlatform $HostRt -KindSource 'inferred'
Test-Equals   -Name 'an inferred kind is flagged as such, not as a read one' `
              -Actual $kindInferred.Provenance -Expected 'kind-inferred'

Test-Equals   -Name 'nothing read and no kind: unknown, never a guess' `
              -Actual (Resolve-RuntimePlatform) -Expected ''

# ---------------------------------------------------------------------------- fixture runtimes
# Real folders, written here and deleted below, in the layout a TwinCAT 4026 install uses:
#     <root>\<name>\3.1\TcRegistry.xml            NetId, and the usermode marker
#     <root>\<name>\3.1\Boot\CurrentConfig.xml    the platform, once activated at least once
$FixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "tc-activation-fixture-$PID"
if (Test-Path -LiteralPath $FixtureRoot) { Remove-Item -LiteralPath $FixtureRoot -Recurse -Force }

function New-FixtureRuntime {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$NetIdHex,                 # 12 hex digits, as TcRegistry.xml stores it
        [string]$DeviceType,
        [switch]$RunAsDevice,
        [string]$BootPlatform,             # writes a CurrentConfig.xml when given
        [switch]$NoRegistryXml
    )
    $dir = Join-Path $FixtureRoot (Join-Path $Name '3.1')
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    if (-not $NoRegistryXml) {
        $body = @()
        if ($DeviceType) {
            $body += '    <Key Name="Ident">'
            $body += "        <Value Name=`"DeviceType`" Type=`"SZ`">$DeviceType</Value>"
            $body += '    </Key>'
        }
        $body += '    <Key Name="System">'
        if ($RunAsDevice) { $body += '        <Value Name="RunAsDevice" Type="DW">1</Value>' }
        if ($NetIdHex)    { $body += "        <Value Name=`"AmsNetId`" Type=`"BIN`">$NetIdHex</Value>" }
        $body += '    </Key>'
        (@('<?xml version="1.0"?>', '<TcRegistry>') + $body + @('</TcRegistry>')) -join "`r`n" |
            Set-Content -LiteralPath (Join-Path $dir 'TcRegistry.xml') -Encoding UTF8
    }

    if ($BootPlatform) {
        $boot = Join-Path $dir 'Boot'
        New-Item -ItemType Directory -Path $boot -Force | Out-Null
        (@('<?xml version="1.0"?>',
           "<TcBootProject CreateTime=`"2026-07-30T08:30:30`" Platform=`"$BootPlatform`">",
           '    <System />',
           '</TcBootProject>') -join "`r`n") |
            Set-Content -LiteralPath (Join-Path $boot 'CurrentConfig.xml') -Encoding UTF8
    }
}

function Test-Fixture {
    param(
        [string]$Name,
        [hashtable]$Records,
        [string]$NetId,
        [string]$ExpectPlatform,
        [string]$ExpectProvenance
    )
    $r = $Records[$NetId]
    if (-not $r) { Write-Fail $Name "no record for $NetId (found: $(($Records.Keys | Sort-Object) -join ', '))"; return }
    $problems = @()
    if ("$($r.Platform)"   -ne $ExpectPlatform)   { $problems += "Platform '$($r.Platform)' != '$ExpectPlatform'" }
    if ("$($r.Provenance)" -ne $ExpectProvenance) { $problems += "Provenance '$($r.Provenance)' != '$ExpectProvenance'" }
    if ($problems.Count -gt 0) { Write-Fail $Name ($problems -join '; ') }
    else { Write-Pass $Name "$NetId -> '$($r.Platform)' [$($r.Provenance)]" }
}

try {
    # C63364040101 -> 198.51.100.4.1.1, and so on up the fourth octet.
    New-FixtureRuntime -Name 'UmRT_marked'      -NetIdHex 'C63364040101' -DeviceType 'PC-WIN-U'
    New-FixtureRuntime -Name 'UmRT_activated'   -NetIdHex 'C63364050101' -DeviceType 'PC-WIN-U' -BootPlatform $OsArm
    New-FixtureRuntime -Name 'UmRT_runasdevice' -NetIdHex 'C63364060101' -RunAsDevice
    New-FixtureRuntime -Name 'UmRT_otherdevice' -NetIdHex 'C63364070101' -DeviceType 'PC-WIN'
    New-FixtureRuntime -Name 'UmRT_nomarker'    -NetIdHex 'C63364080101'
    New-FixtureRuntime -Name 'UmRT_unknownkind' -NetIdHex 'C63364090101' -DeviceType 'PC-CE7' -BootPlatform 'TwinCAT OS (ARMV7-A)'
    New-FixtureRuntime -Name 'bin'              -NoRegistryXml -BootPlatform $Rt64

    # Every fixture runtime is running, started after its file was written: every NetId is trusted.
    $fixtureNames = @(Get-ChildItem -LiteralPath $FixtureRoot -Directory | ForEach-Object { $_.Name })
    $runningAll   = @($fixtureNames | ForEach-Object {
        New-UmProcess -CommandLine "$UmExe -t bin -i path -n `"$_`" -c .\3.1" -StartTime (Get-Date).AddMinutes(1) })
    $records = @{}
    foreach ($r in Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot -Processes $runningAll) { $records[$r.NetId] = $r }

    Test-Fixture  -Name 'THE CASE THE OLD CODE GOT WRONG: a user-mode runtime with no boot config' `
                  -Records $records -NetId '198.51.100.4.1.1' `
                  -ExpectPlatform $HostOs -ExpectProvenance 'architecture-inferred'

    Test-Fixture  -Name 'a boot configuration OVERRIDES the assembled platform, architecture and all' `
                  -Records $records -NetId '198.51.100.5.1.1' `
                  -ExpectPlatform $OsArm -ExpectProvenance 'read'

    Test-Fixture  -Name 'RunAsDevice=1 alone marks a user-mode runtime' `
                  -Records $records -NetId '198.51.100.6.1.1' `
                  -ExpectPlatform $HostOs -ExpectProvenance 'architecture-inferred'

    Test-Fixture  -Name 'DeviceType PC-WIN is NOT read as usermode: unknown rather than a guess' `
                  -Records $records -NetId '198.51.100.7.1.1' `
                  -ExpectPlatform '' -ExpectProvenance ''

    Test-Fixture  -Name 'no marker at all is unknown too - the inference never leaks to user-mode' `
                  -Records $records -NetId '198.51.100.8.1.1' `
                  -ExpectPlatform '' -ExpectProvenance ''

    Test-Fixture  -Name 'an unrecognised kind still yields a platform when the boot config is there' `
                  -Records $records -NetId '198.51.100.9.1.1' `
                  -ExpectPlatform 'TwinCAT OS (ARMV7-A)' -ExpectProvenance 'read'

    if ($records.Count -eq 6) {
        Write-Pass 'a folder with no TcRegistry.xml is not a runtime (the shared bin\ folder)' `
                   "6 runtimes from 7 folders"
    } else {
        Write-Fail 'a folder with no TcRegistry.xml is not a runtime (the shared bin\ folder)' `
                   "got $($records.Count) records, expected 6: $(($records.Keys | Sort-Object) -join ', ')"
    }

    # The pairing property, stated directly: the platform read for one folder must not be attributed to
    # another folder's NetId. UmRT_activated is the only fixture with an ARMV8-A boot configuration.
    $arm = @($records.Values | Where-Object { "$($_.Platform)" -eq $OsArm })
    if ($arm.Count -eq 1 -and $arm[0].NetId -eq '198.51.100.5.1.1') {
        Write-Pass 'a platform belongs to the runtime whose FOLDER it was read from' `
                   "only 198.51.100.5.1.1 got '$OsArm'"
    } else {
        Write-Fail 'a platform belongs to the runtime whose FOLDER it was read from' `
                   "'$OsArm' landed on $(($arm | ForEach-Object { $_.NetId }) -join ', ')"
    }

    # And the whole chain end to end: the fixture map, handed to the gate exactly as the builder hands
    # it the real one. This is the user's bug, reproduced from files rather than from a hand-written map.
    $fixtureMap = @{}
    foreach ($k in $records.Keys) {
        $fixtureMap[$k] = $(if ($records[$k].Platform) {
            [pscustomobject]@{ Platform = $records[$k].Platform; Provenance = $records[$k].Provenance }
        } else { $null })
    }
    Test-Allows   -Name 'end to end: a TwinCAT OS build is allowed onto a runtime measured as TwinCAT OS' `
                  -Local @('198.51.100.4.1.1') -Platform $HostOs -TargetPlatforms $fixtureMap `
                  -ExpectTarget '198.51.100.4.1.1' -ExpectSource 'first-local' `
                  -ExpectPlatform $HostOs -ExpectNoWarnings

    Test-Refuses  -Name 'end to end: the same runtime refuses a TwinCAT RT build, saying the arch was inferred' `
                  -Local @('198.51.100.4.1.1') -Platform $HostRt -TargetPlatforms $fixtureMap `
                  -MessageContains @($HostRt, $HostOs, '198.51.100.4.1.1', 'inferred')

    # The trust rule over real files. Started an hour ago, so every file (written just now) is newer
    # than its instance: no NetId is trusted, every one is kept as FileNetId with the reason.
    $runningOld = @($fixtureNames | ForEach-Object {
        New-UmProcess -CommandLine "$UmExe -n `"$_`"" -StartTime (Get-Date).AddHours(-1) })
    $stale = @(Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot -Processes $runningOld)
    $staleProblems = @()
    if ($stale.Count -ne 6) { $staleProblems += "expected 6 records, got $($stale.Count)" }
    foreach ($r in $stale) {
        if ($r.NetId) { $staleProblems += "$($r.Name): NetId '$($r.NetId)' trusted" }
        if ($r.NetIdStatus -ne 'rewritten') { $staleProblems += "$($r.Name): status '$($r.NetIdStatus)'" }
        if (-not $r.FileNetId) { $staleProblems += "$($r.Name): FileNetId lost" }
    }
    $staleUm = @($stale | Where-Object { $_.Name -eq 'UmRT_marked' })
    if ($staleUm.Count -ne 1 -or $staleUm[0].FileNetId -ne '198.51.100.4.1.1') { $staleProblems += 'UmRT_marked FileNetId is not 198.51.100.4.1.1' }
    if ($staleProblems.Count -gt 0) { Write-Fail 'a file rewritten after its instance started gives no NetId, only FileNetId' ($staleProblems -join '; ') }
    else { Write-Pass 'a file rewritten after its instance started gives no NetId, only FileNetId' "$($stale.Count) records, all 'rewritten'" }

    # The same stale files with a probe: a runtime that answers is trusted via ads, one that does not
    # stays unknown, and a not-running runtime is never asked.
    $answering = { param($n) if ($n -eq '198.51.100.4.1.1') { [pscustomobject]@{ AdsState = 5; StateName = 'RUN' } }
                             else { [pscustomobject]@{ AdsState = $null; AdsErrorCode = 7 } } }
    $confirmed = @(Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot -Processes $runningOld -ConfirmNetId $answering)
    $confirmedUm = @($confirmed | Where-Object { $_.NetId })
    if ($confirmedUm.Count -eq 1 -and $confirmedUm[0].Name -eq 'UmRT_marked' -and $confirmedUm[0].NetIdSource -eq 'ads' -and
        @($confirmed | Where-Object { -not $_.NetId -and $_.NetIdStatus -eq 'rewritten' -and $_.NetIdReason -like '*ADS error 0x7*' }).Count -eq 5) {
        Write-Pass 'a rewritten record whose runtime answers over ADS is trusted (source ads); the others stay rewritten' 'UmRT_marked via ads, 5 rewritten'
    } else {
        Write-Fail 'a rewritten record whose runtime answers over ADS is trusted (source ads); the others stay rewritten' `
                   (($confirmed | ForEach-Object { "$($_.Name)=$($_.NetId)/$($_.NetIdStatus)/$($_.NetIdSource)" }) -join ', ')
    }
    $trustedByTime = @(Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot -Processes $runningAll -ConfirmNetId { throw 'must not be called' })
    Test-Equals -Name 'records trusted by the file times carry source file-time and never call the probe' `
                -Actual (($trustedByTime | ForEach-Object { "$($_.NetIdStatus)/$($_.NetIdSource)" } | Sort-Object -Unique) -join ',') -Expected 'trusted/file-time'
    $notRunningProbed = @(Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot -ConfirmNetId { throw 'must not be called' })
    Test-Equals -Name 'not-running records are never probed' `
                -Actual (($notRunningProbed | ForEach-Object { "$($_.NetIdStatus)$(if ($_.NetIdReason -like '*ADS*') { '+ads' })" } | Sort-Object -Unique) -join ',') -Expected 'not-running'

    $notRunning = @(Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot)
    if (@($notRunning | Where-Object { $_.NetId -or $_.NetIdStatus -ne 'not-running' }).Count -eq 0 -and $notRunning.Count -eq 6) {
        Write-Pass 'without a process list nothing is running, so nothing is trusted (fail closed)' "$($notRunning.Count) records, all 'not-running'"
    } else {
        Write-Fail 'without a process list nothing is running, so nothing is trusted (fail closed)' `
                   (($notRunning | ForEach-Object { "$($_.Name)=$($_.NetId)/$($_.NetIdStatus)" }) -join ', ')
    }

    $failedList = @(Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot -Processes @() -ProcessListFailed)
    Test-Equals -Name 'a process list that could not be read leaves every NetId unverifiable' `
                -Actual (($failedList | ForEach-Object { $_.NetIdStatus } | Sort-Object -Unique) -join ',') -Expected 'unverifiable'

    # Get-RuntimeLabels and the local set skip the unknown records (they key on NetId).
    if ((Get-RuntimeLabels -Records $stale).Count -eq 0) { Write-Pass 'an unknown NetId gets no runtime label (it is not local)' '' }
    else { Write-Fail 'an unknown NetId gets no runtime label (it is not local)' "$((Get-RuntimeLabels -Records $stale).Keys -join ', ')" }

    Test-Allows   -Name 'end to end: a runtime with no readable kind is allowed with the warning' `
                  -Local @('198.51.100.8.1.1') -Platform $Rt64 -TargetPlatforms $fixtureMap `
                  -ExpectTarget '198.51.100.8.1.1' -ExpectSource 'first-local' -ExpectPlatform '' `
                  -ExpectWarning @($UnknownWarning)
}
finally {
    if (Test-Path -LiteralPath $FixtureRoot) {
        Remove-Item -LiteralPath $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
if ($script:failed -eq 0) {
    Write-Host "ALL $($script:passed) TESTS PASSED." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($script:failed) of $($script:passed + $script:failed) TESTS FAILED." -ForegroundColor Red
    exit 1
}
