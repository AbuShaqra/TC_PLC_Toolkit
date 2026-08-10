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

# A signature check, not a style check. The table below is written against -TargetPlatforms - a
# PER-TARGET map - and would be meaningless against a builder that still asks about the host, so say
# so rather than reporting green.
$gateParams = @((Get-Command Resolve-ActivationTarget -CommandType Function).Parameters.Keys)
foreach ($needed in 'LocalNetIds', 'RequestedNetId', 'ProjectNetId', 'Platform', 'TargetPlatforms',
                    'Configuration') {
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
        [string[]]$MessageLacks          # the gate that must NOT report - this is how precedence is pinned
    )
    if (-not $Platform) { $Platform = $Rt64 }
    if (-not $PSBoundParameters.ContainsKey('TargetPlatforms')) { $TargetPlatforms = $AllRt64 }
    try {
        $r = Resolve-ActivationTarget -LocalNetIds $Local -RequestedNetId $Requested `
                                      -ProjectNetId $Project -Platform $Platform `
                                      -TargetPlatforms $TargetPlatforms -Configuration $Configuration
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

    $records = @{}
    foreach ($r in Get-UserModeRuntimeRecords -RuntimesRoot $FixtureRoot) { $records[$r.NetId] = $r }

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
