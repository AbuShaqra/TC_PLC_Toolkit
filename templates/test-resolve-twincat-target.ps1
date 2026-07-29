<#
.SYNOPSIS
    Unit tests for Resolve-TwinCatTarget in build_plc_project.ps1.

.DESCRIPTION
    Resolve-TwinCatTarget is the COM-free half of the builder's version handling: it decides which
    TwinCAT version and which XAE Shell a run uses, and refuses combinations that contradict the
    project's saved version. Being pure is what makes it testable - this script needs no TwinCAT
    installation, no XAE Shell and no solution, and never launches an IDE.

    build_plc_project.ps1 BUILDS when it is run or dot-sourced, so the function cannot simply be
    dot-sourced out of it. It is lifted from the file's real source text with the PowerShell parser
    instead, along with the $ProgIdByBuild map, so the tests track the script rather than a copy.

.PARAMETER ScriptPath
    The script under test. Defaults to build_plc_project.ps1 beside this file. (Resolved after the
    param block, not in it: $PSScriptRoot is not yet populated while parameter defaults are bound
    under `powershell -File`.)

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File Scripts\test-resolve-twincat-target.ps1

.NOTES
    Exit codes:  0  every case passed
                 1  at least one case failed
                 2  the harness itself could not run (script missing, parse error, function gone)
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

$fnAst = $ast.Find({
    param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Resolve-TwinCatTarget'
}, $true)
if (-not $fnAst) { Fail-Harness "no function Resolve-TwinCatTarget in $ScriptPath" }
. ([scriptblock]::Create($fnAst.Extent.Text))

$mapAst = $ast.Find({
    param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $n.Left.VariablePath.UserPath -eq 'ProgIdByBuild'
}, $true)
if (-not $mapAst) { Fail-Harness "no `$ProgIdByBuild table in $ScriptPath" }
$ProgIdByBuild = & ([scriptblock]::Create($mapAst.Right.Extent.Text))

# The table below is written against these two rows; if the script's map ever loses them the
# expectations are meaningless, so say so rather than reporting green.
foreach ($expected in @('4024', '4026')) {
    if (-not $ProgIdByBuild.ContainsKey($expected)) {
        Fail-Harness "`$ProgIdByBuild has no '$expected' row - these tests assume 4024 and 4026 are mapped."
    }
}
$Shell4024 = $ProgIdByBuild['4024']
$Shell4026 = $ProgIdByBuild['4026']

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

# One line of a thrown message, so a multi-line "FATAL:`n       Pass -Allow..." stays readable.
function Format-Message {
    param([string]$Text)
    return (($Text -split "`r?`n" | ForEach-Object { $_.Trim() }) -join ' ')
}

function Test-Resolves {
    param(
        [string]$Name,
        [string]$Requested,
        [string]$Project,
        [switch]$Allow,
        [string]$ExpectVersion,
        [string]$ExpectProgId,
        [int]$ExpectWarnings
    )
    try {
        $r = Resolve-TwinCatTarget -Requested $Requested -ProjectVersion $Project `
                                   -ProgIdByBuild $ProgIdByBuild -AllowMismatch:$Allow
    } catch {
        Write-Fail $Name ("threw unexpectedly: " + (Format-Message "$_"))
        return
    }

    $problems = @()
    $warnings = @($r.Warnings)
    $expectBuild = ($ExpectVersion -split '\.')[2]

    if ($r.EffectiveVersion -ne $ExpectVersion) { $problems += "EffectiveVersion '$($r.EffectiveVersion)' != '$ExpectVersion'" }
    if ($r.ProgId           -ne $ExpectProgId)  { $problems += "ProgId '$($r.ProgId)' != '$ExpectProgId'" }
    if ($r.ProjectVersion   -ne $Project)       { $problems += "ProjectVersion '$($r.ProjectVersion)' != '$Project'" }
    if ($r.Build            -ne $expectBuild)   { $problems += "Build '$($r.Build)' != '$expectBuild'" }
    if ($warnings.Count     -ne $ExpectWarnings) {
        $problems += "Warnings $($warnings.Count) != $ExpectWarnings [$($warnings -join ' | ')]"
    }

    if ($problems.Count -gt 0) {
        Write-Fail $Name ($problems -join '; ')
    } else {
        $detail = "$($r.EffectiveVersion) -> $($r.ProgId), $($warnings.Count) warning(s)"
        if ($warnings.Count -gt 0) { $detail += ": " + (Format-Message ($warnings -join ' | ')) }
        Write-Pass $Name $detail
    }
}

function Test-Throws {
    param(
        [string]$Name,
        [string]$Requested,
        [string]$Project,
        [switch]$Allow,
        [string[]]$MessageContains
    )
    try {
        $r = Resolve-TwinCatTarget -Requested $Requested -ProjectVersion $Project `
                                   -ProgIdByBuild $ProgIdByBuild -AllowMismatch:$Allow
        Write-Fail $Name "did not throw; returned $($r.EffectiveVersion) -> $($r.ProgId)"
        return
    } catch {
        $msg = "$_"
        $missing = @($MessageContains | Where-Object { $msg -notlike "*$_*" })
        if ($missing.Count -gt 0) {
            Write-Fail $Name ("message does not mention " + ($missing -join ', ') + " -- got: " + (Format-Message $msg))
        } else {
            Write-Pass $Name ("threw: " + (Format-Message $msg))
        }
    }
}

Write-Host "Resolve-TwinCatTarget  (source: $ScriptPath)" -ForegroundColor Cyan
Write-Host "  map: $(($ProgIdByBuild.Keys | Sort-Object | ForEach-Object { "$_ -> $($ProgIdByBuild[$_])" }) -join ',  ')" -ForegroundColor DarkGray
Write-Host ""

Test-Resolves -Name 'no -TcVersion: the project decides' `
              -Requested '' -Project '3.1.4026.22' `
              -ExpectVersion '3.1.4026.22' -ExpectProgId $Shell4026 -ExpectWarnings 0

Test-Resolves -Name 'exact match is silent' `
              -Requested '3.1.4026.22' -Project '3.1.4026.22' `
              -ExpectVersion '3.1.4026.22' -ExpectProgId $Shell4026 -ExpectWarnings 0

Test-Resolves -Name 'revision drift warns, does not fail' `
              -Requested '3.1.4026.17' -Project '3.1.4026.22' `
              -ExpectVersion '3.1.4026.17' -ExpectProgId $Shell4026 -ExpectWarnings 1

Test-Throws   -Name 'build mismatch is fatal' `
              -Requested '3.1.4024.62' -Project '3.1.4026.22' `
              -MessageContains @('4024', '4026', '-AllowVersionMismatch')

Test-Resolves -Name 'build mismatch is allowed by -AllowMismatch, with a warning' `
              -Requested '3.1.4024.62' -Project '3.1.4026.22' -Allow `
              -ExpectVersion '3.1.4024.62' -ExpectProgId $Shell4024 -ExpectWarnings 1

Test-Resolves -Name 'a ProgId selects the build and inherits the project revision' `
              -Requested $Shell4026 -Project '3.1.4026.22' `
              -ExpectVersion '3.1.4026.22' -ExpectProgId $Shell4026 -ExpectWarnings 0

Test-Resolves -Name 'a ProgId is matched case-insensitively' `
              -Requested $Shell4026.ToUpper() -Project '3.1.4026.22' `
              -ExpectVersion '3.1.4026.22' -ExpectProgId $Shell4026 -ExpectWarnings 0

Test-Throws   -Name 'a ProgId from the wrong build family is fatal' `
              -Requested $Shell4024 -Project '3.1.4026.22' `
              -MessageContains @('4024', '4026')

Test-Throws   -Name 'unparseable -TcVersion lists the accepted forms' `
              -Requested 'garbage' -Project '3.1.4026.22' `
              -MessageContains @('garbage', '3.1.4026.22', $Shell4024, $Shell4026)

Test-Throws   -Name 'unparseable -TcVersion stays fatal under -AllowMismatch' `
              -Requested 'garbage' -Project '3.1.4026.22' -Allow `
              -MessageContains @('garbage')

Test-Throws   -Name 'a build with no shell mapping is fatal' `
              -Requested '' -Project '3.1.4099.1' `
              -MessageContains @('4099', 'Known builds')

Test-Throws   -Name 'an unmappable build stays fatal under -AllowMismatch' `
              -Requested '3.1.4099.1' -Project '3.1.4026.22' -Allow `
              -MessageContains @('4099', 'Known builds')

Test-Throws   -Name 'a malformed project version is fatal' `
              -Requested '' -Project 'not-a-version' `
              -MessageContains @('not-a-version')

Write-Host ""
if ($script:failed -eq 0) {
    Write-Host "ALL $($script:passed) TESTS PASSED." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($script:failed) of $($script:passed + $script:failed) TESTS FAILED." -ForegroundColor Red
    exit 1
}
