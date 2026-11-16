<#
.SYNOPSIS
    Unit tests for the boot-project step of build_plc_project.ps1 (and the XAE build driver): which
    tree item answers, when BootProjectAutostart is written, how failures are reported, the PLC ports
    read from the system project, and the PLC run states after the restart.

.DESCRIPTION
    Install-PlcBootProjects, Get-PlcAmsPorts and Read-PlcRunStates are lifted from the script's real
    source text with the PowerShell parser (the script builds when it is run or dot-sourced) and run
    against FAKE tree items: PowerShell objects with the members ITcSmTreeItem / ITcPlcProject expose
    (Name, ChildCount, Child(i), BootProjectAutostart, GenerateBootProject(bool)). No XAE Shell, no
    TwinCAT runtime and no network is involved, and nothing is installed anywhere.

    What the fakes cannot show is how the real XAE Shell answers - which item exposes ITcPlcProject on
    a given version, and whether GenerateBootProject($true) needs anything else. That is the Windows
    check in build_plc_project.md ("Boot project").

    Get-PlcAmsPorts runs against the repository's own synthetic samples under sample/.

.PARAMETER ScriptPath
    The script under test. Defaults to build_plc_project.ps1 beside this file; pass
    ..\..\resources\xae\build-plc-project.ps1 to test the extension's driver.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\test-boot-project.ps1

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

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ScriptPath) { $ScriptPath = Join-Path $here 'build_plc_project.ps1' }
if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { Fail-Harness "script under test not found: $ScriptPath" }

$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
    Fail-Harness ("$ScriptPath has $($parseErrors.Count) parse error(s):`n" + (($parseErrors | ForEach-Object { "  $_" }) -join "`n"))
}

function Get-FunctionText {
    param([string]$Name)
    $fnAst = $ast.Find({
        param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name
    }, $true)
    if (-not $fnAst) { Fail-Harness "no function $Name in $ScriptPath" }
    return $fnAst.Extent.Text
}

. ([scriptblock]::Create((Get-FunctionText 'Invoke-ComRetry')))
. ([scriptblock]::Create((Get-FunctionText 'Install-PlcBootProjects')))
. ([scriptblock]::Create((Get-FunctionText 'Get-PlcAmsPorts')))
. ([scriptblock]::Create((Get-FunctionText 'Read-PlcRunStates')))
# The driver's Invoke-ComRetry checks for a cancel on a rejected call; nothing is rejected here.
function Test-CancelRequested { }

$script:passed = 0
$script:failed = 0
function Test-Equals {
    param([string]$Name, $Actual, $Expected)
    if ("$Actual" -eq "$Expected") {
        $script:passed++
        Write-Host ("  PASS  " + $Name) -ForegroundColor Green
    } else {
        $script:failed++
        Write-Host ("  FAIL  " + $Name) -ForegroundColor Red
        Write-Host ("          expected '$Expected', got '$Actual'") -ForegroundColor Red
    }
}

# A fake tree item. -Autostart $null: the item has no BootProjectAutostart (ITcPlcProject is elsewhere).
# Writes counts the setter calls; -Sticky makes the setter ignore the value (a write that does not take).
function New-FakeItem {
    param([string]$Name, $Autostart = $null, [object[]]$Children = @(), [switch]$FailGenerate, [switch]$Sticky)
    $o = [pscustomobject]@{ Name = $Name; ChildCount = $Children.Count; Kids = $Children; Generated = @()
                            FailGenerate = [bool]$FailGenerate; Sticky = [bool]$Sticky; Auto = $Autostart; Writes = 0 }
    if ($null -ne $Autostart) {
        $o | Add-Member -MemberType ScriptProperty -Name BootProjectAutostart -Value { $this.Auto } -SecondValue {
            param($v) $this.Writes++; if (-not $this.Sticky) { $this.Auto = $v }
        }
    }
    $o | Add-Member -MemberType ScriptMethod -Name Child -Value { param($i) $this.Kids[$i - 1] }
    $o | Add-Member -MemberType ScriptMethod -Name GenerateBootProject -Value {
        param($activate)
        if ($this.FailGenerate) { throw 'Exception from HRESULT: 0x80004005 (E_FAIL)' }
        $this.Generated += $activate
    }
    return $o
}
function New-FakeSysManager {
    param([object[]]$Plcs, [switch]$NoTipc)
    $tipc = New-FakeItem -Name 'PLC' -Children $Plcs
    $sm = [pscustomobject]@{ Tipc = $tipc; NoTipc = [bool]$NoTipc }
    $sm | Add-Member -MemberType ScriptMethod -Name LookupTreeItem -Value {
        param($path) if ($this.NoTipc -or $path -ne 'TIPC') { throw "no item $path" }; $this.Tipc
    }
    return $sm
}

Write-Host "Install-PlcBootProjects  (source: $ScriptPath)" -ForegroundColor Cyan

# 1. ITcPlcProject on the root item, autostart off: written once, then the boot project is sent.
$p1 = New-FakeItem -Name 'PLC_A' -Autostart $false -Children @((New-FakeItem -Name 'PLC_A Project'))
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @($p1))
Test-Equals 'root item, autostart off: outcome installed' $r.Outcome 'installed'
Test-Equals 'root item: node root, was False, now True, installed' (
    '{0}/{1}/{2}/{3}' -f $r.Projects[0].node, $r.Projects[0].wasAutostart, $r.Projects[0].autostart, $r.Projects[0].installed) 'root/False/True/True'
Test-Equals 'autostart off: written exactly once' $p1.Writes 1
Test-Equals 'GenerateBootProject called once, with $true' ($p1.Generated -join ',') 'True'

# 2. Autostart already on: never written (no change to the project), still installed.
$p2 = New-FakeItem -Name 'PLC_B' -Autostart $true
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @($p2))
Test-Equals 'autostart already on: not written' $p2.Writes 0
Test-Equals 'autostart already on: installed, was True' ('{0}/{1}' -f $r.Projects[0].installed, $r.Projects[0].wasAutostart) 'True/True'

# 3. ITcPlcProject on the nested '<name> Project' item instead.
$nested = New-FakeItem -Name 'PLC_C Project' -Autostart $false
$p3 = New-FakeItem -Name 'PLC_C' -Children @((New-FakeItem -Name 'PLC_C Instance'), $nested)
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @($p3))
Test-Equals 'nested item answers: node nested, installed' ('{0}/{1}' -f $r.Projects[0].node, $r.Projects[0].installed) 'nested/True'
Test-Equals 'nested item: the boot project is generated there' ($nested.Generated -join ',') 'True'

# 4. Neither item exposes it: reported, not thrown.
$p4 = New-FakeItem -Name 'PLC_D' -Children @((New-FakeItem -Name 'PLC_D Project'))
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @($p4))
Test-Equals 'no ITcPlcProject anywhere: outcome failed' $r.Outcome 'failed'
Test-Equals 'no ITcPlcProject anywhere: the error says so' ($r.Projects[0].error -match 'BootProjectAutostart') $true

# 5. One project fails to generate, one succeeds: partial, and the failure is named.
$ok = New-FakeItem -Name 'PLC_E' -Autostart $false
$bad = New-FakeItem -Name 'PLC_F' -Autostart $false -FailGenerate
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @($ok, $bad))
Test-Equals 'one of two fails: outcome partial' $r.Outcome 'partial'
Test-Equals 'the failed one carries the COM error' ($r.Projects[1].error -match 'E_FAIL') $true
Test-Equals 'the failed one is not installed, the other is' ('{0}/{1}' -f $r.Projects[0].installed, $r.Projects[1].installed) 'True/False'

# 6. A write that does not take: refused before any boot project is sent.
$sticky = New-FakeItem -Name 'PLC_G' -Autostart $false -Sticky
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @($sticky))
Test-Equals 'autostart still False after the write: not installed' ('{0}/{1}' -f $r.Projects[0].installed, ($sticky.Generated.Count)) 'False/0'

# 7. No PLC project; 8. the PLC node unreadable.
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @())
Test-Equals 'no PLC project: outcome none' $r.Outcome 'none'
$r = Install-PlcBootProjects -SysManager (New-FakeSysManager -Plcs @() -NoTipc)
Test-Equals 'TIPC unreadable: outcome failed with an error' ('{0}/{1}' -f $r.Outcome, [bool]$r.Error) 'failed/True'

Write-Host ""
Write-Host "Get-PlcAmsPorts  (the repository's synthetic samples)" -ForegroundColor Cyan
$repo = Resolve-Path (Join-Path $here '..\..')
$s1 = Join-Path $repo 'sample\TcToolkitSample\TcToolkitSample.tsproj'
$s2 = Join-Path $repo 'sample\TcToolkitSample2\TcToolkitSample2\TcToolkitSample2.tspproj'
if (Test-Path -LiteralPath $s1) {
    Test-Equals 'sample 1: the port comes from _Config\PLC\*.xti' (Get-PlcAmsPorts -TsprojPath $s1)['TcToolkitSample_PLC'] 851
} else { Write-Host "  SKIP  sample 1 not found: $s1" -ForegroundColor DarkGray }
if (Test-Path -LiteralPath $s2) {
    Test-Equals 'sample 2: the port comes from the .tspproj itself' (Get-PlcAmsPorts -TsprojPath $s2)['TcToolkitSample2_PLC'] 851
} else { Write-Host "  SKIP  sample 2 not found: $s2" -ForegroundColor DarkGray }
Test-Equals 'a missing file gives an empty map' (Get-PlcAmsPorts -TsprojPath (Join-Path $env:TEMP 'no-such-dir\none.tsproj')).Count 0

Write-Host ""
Write-Host "Read-PlcRunStates  (Get-TcAdsState stubbed)" -ForegroundColor Cyan
$TcAdsStateNames = @{ 0 = 'INVALID'; 5 = 'RUN'; 6 = 'STOP' }
$script:StubStates = @{ 851 = 5; 852 = 0 }
function Get-TcAdsState { param([string]$NetId, [int]$Port = 10000) return $script:StubStates[$Port] }
$projects = @(
    [pscustomobject]@{ name = 'PLC_A'; installed = $true },
    [pscustomobject]@{ name = 'PLC_B'; installed = $true },
    [pscustomobject]@{ name = 'PLC_C'; installed = $false },
    [pscustomobject]@{ name = 'PLC_D'; installed = $true })
$states = @(Read-PlcRunStates -NetId '10.0.0.4.1.1' -Projects $projects -Ports @{ PLC_A = 851; PLC_B = 852; PLC_C = 853 } -TimeoutSec 0)
Test-Equals 'only installed projects with a known port are read' (($states | ForEach-Object { $_.name }) -join ',') 'PLC_A,PLC_B'
Test-Equals 'RUN and INVALID are reported as such' (($states | ForEach-Object { "$($_.port)=$($_.stateName)" }) -join ',') '851=RUN,852=INVALID'

Write-Host ""
if ($script:failed -eq 0) {
    Write-Host "ALL $($script:passed) TESTS PASSED." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($script:failed) of $($script:passed + $script:failed) TESTS FAILED." -ForegroundColor Red
    exit 1
}
