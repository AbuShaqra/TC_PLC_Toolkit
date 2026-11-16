<#
.SYNOPSIS
    Unit tests for Emit-Event in resources/xae/build-plc-project.ps1 (the XAE build driver, R14).

.DESCRIPTION
    Emit-Event writes the driver's machine-readable lines: the prefix '@@TCTK ', then compact JSON
    carrying v=1 and t=<type>, every non-ASCII character escaped as \uXXXX so the line survives any
    console code page. This checks the prefix, the escaping (a German umlaut, a quote, a backslash),
    that nothing is written without -Json, and that the line is valid JSON.

    The driver BUILDS when it is run or dot-sourced, so Emit-Event is lifted from the file's source
    text with the PowerShell parser, as test-resolve-twincat-target.ps1 does. Windows-only by nature
    (Windows PowerShell 5.1 is the host the driver targets); the JS side is test/test_xae_build.js.

.PARAMETER ScriptPath
    The script under test. Defaults to resources\xae\build-plc-project.ps1 in this repository.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\Build PLC project\test-emit-event.ps1"

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
    $ScriptPath = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'resources\xae\build-plc-project.ps1'
}
if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { Fail-Harness "script under test not found: $ScriptPath" }

$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Fail-Harness ("$ScriptPath has $($parseErrors.Count) parse error(s):`n" +
                  (($parseErrors | ForEach-Object { "  $_" }) -join "`n"))
}
$fnAst = $ast.Find({
    param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Emit-Event'
}, $true)
if (-not $fnAst) { Fail-Harness "no function Emit-Event in $ScriptPath" }
. ([scriptblock]::Create($fnAst.Extent.Text))

$script:passed = 0
$script:failed = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    if ($Ok) { $script:passed++; Write-Host ("  PASS  " + $Name) -ForegroundColor Green }
    else     { $script:failed++; Write-Host ("  FAIL  " + $Name) -ForegroundColor Red; Write-Host ("          " + $Detail) -ForegroundColor Red }
}

# Runs Emit-Event with [Console]::Out captured.
function Capture {
    param([scriptblock]$Body)
    $old = [Console]::Out
    $sw = New-Object System.IO.StringWriter
    [Console]::SetOut($sw)
    try { & $Body } finally { [Console]::SetOut($old) }
    return $sw.ToString()
}

$Json = $false
$none = Capture { Emit-Event 'phase' ([ordered]@{ name = 'build' }) }
Check 'nothing is written without -Json' ($none -eq '') "got: $none"

$Json = $true
$umlaut = 'Ger' + [char]0x00E4 + 't "x" C:\a'
$out = Capture { Emit-Event 'warning' ([ordered]@{ text = $umlaut }) }
$line = ($out -split "`r?`n")[0]
Check 'the line starts with the prefix' ($line.StartsWith('@@TCTK {')) "got: $line"
Check 'the line is pure ASCII' (-not ($line.ToCharArray() | Where-Object { [int]$_ -gt 127 })) "got: $line"
Check 'the umlaut is escaped as \u00e4' ($line.Contains('Ger\u00e4t')) "got: $line"
$obj = $null
try { $obj = $line.Substring(7) | ConvertFrom-Json } catch { }
Check 'the rest is JSON' ($null -ne $obj) "got: $line"
if ($obj) {
    Check 'v is 1 and t is the type' ($obj.v -eq 1 -and $obj.t -eq 'warning') "got: $line"
    Check 'the text round-trips (umlaut, quotes, backslash)' ($obj.text -eq $umlaut) "got: $($obj.text)"
}
$arr = Capture { Emit-Event 'shell' ([ordered]@{ pid = $null; ours = $false; preexisting = @(12) }) }
$o2 = $null
try { $o2 = ($arr -split "`r?`n")[0].Substring(7) | ConvertFrom-Json } catch { }
Check 'a one-element array stays an array; null stays null' ($o2 -and $null -eq $o2.pid -and @($o2.preexisting).Count -eq 1 -and $arr.Contains('"preexisting":[12]')) "got: $arr"

Write-Host ""
Write-Host ("{0} passed, {1} failed" -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
