# Manual Windows smoke test of the online-monitoring ADS helper (roadmap R15 phase 2).
# Dev-only: excluded from the VSIX by .vscodeignore. Keep this file ASCII (Windows PowerShell 5.1).
<#
.SYNOPSIS
    Drives resources/online/ads-helper.ps1 with a few JSON lines against a real runtime and prints
    each request and answer, plus the round-trip latency of the helper.

.DESCRIPTION
    Run from the repository root in Windows PowerShell 5.1 (powershell.exe), on the PC with the
    TwinCAT runtime:

        powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\Online helper smoke\smoke-ads-helper.ps1" -NetId 10.0.0.4.1.1

    -NetId is the RUNTIME's AMS Net ID (for the user-mode runtime: the "AmsNetId:" line in its console
    window), not the router's. Steps:
      1. the helper's ready line (which TwinCAT.Ads.dll it loaded, its version, the PowerShell bitness);
      2. port 10000 (TwinCAT system service): ReadState, ReadDeviceInfo;
      3. port -Port (851, the PLC): open, ReadState, ReadDeviceInfo, the symbol version (0xF008);
      4. the symbol TwinCAT_SystemInfoVarList._AppInfo.ProjectName by name (0xF009) and its value;
      5. 20 ReadState round trips, timed;
      6. "close", and the helper's exit code.
    Nothing is written to the PLC.

.PARAMETER NetId
    The runtime's AMS Net ID, for example 10.0.0.4.1.1.

.PARAMETER Port
    The PLC runtime's ADS port (851 for the first).

.PARAMETER AdsDll
    Passed to the helper: use this TwinCAT.Ads.dll instead of searching.
#>
param(
    [Parameter(Mandatory = $true)][string]$NetId,
    [int]$Port = 851,
    [string]$AdsDll = ''
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '..\..\resources\online\ads-helper.ps1'
$helper = (Resolve-Path -LiteralPath $helper).Path

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -TimeoutMs 2000'
if ($AdsDll) { $psi.Arguments += ' -AdsDll "' + $AdsDll + '"' }
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

function Read-Answer {
    $line = $proc.StandardOutput.ReadLine()
    if ($null -eq $line) { throw ('the helper exited: ' + $proc.StandardError.ReadToEnd()) }
    Write-Host ('  <- ' + $line)
    return $line | ConvertFrom-Json
}

$script:nextId = 1
function Send-Request([hashtable]$Request) {
    $Request.id = $script:nextId
    $script:nextId++
    $json = $Request | ConvertTo-Json -Compress
    Write-Host ('  -> ' + $json)
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
    return Read-Answer
}

Write-Host '1. ready line'
$ready = Read-Answer
if (-not $ready.ok) { Write-Host 'The helper did not start (see the line above).'; exit 1 }

Write-Host '2. TwinCAT system service (port 10000)'
[void](Send-Request @{ cmd = 'state'; netId = $NetId; port = 10000 })
[void](Send-Request @{ cmd = 'deviceinfo'; netId = $NetId; port = 10000 })

Write-Host ('3. PLC (port {0})' -f $Port)
[void](Send-Request @{ cmd = 'open'; netId = $NetId; port = $Port })
[void](Send-Request @{ cmd = 'state'; netId = $NetId; port = $Port })
[void](Send-Request @{ cmd = 'deviceinfo'; netId = $NetId; port = $Port })
[void](Send-Request @{ cmd = 'read'; netId = $NetId; port = $Port; ig = 0xF008; io = 0; len = 1 })

Write-Host '4. _AppInfo.ProjectName by name'
$name = 'TwinCAT_SystemInfoVarList._AppInfo.ProjectName'
$nameBytes = [Text.Encoding]::ASCII.GetBytes($name + [char]0)
$info = Send-Request @{ cmd = 'readwrite'; netId = $NetId; port = $Port; ig = 0xF009; io = 0; len = 65536; data = [Convert]::ToBase64String($nameBytes) }
if ($info.ok) {
    $entry = [Convert]::FromBase64String($info.data)
    $ig = [BitConverter]::ToUInt32($entry, 4); $io = [BitConverter]::ToUInt32($entry, 8); $size = [BitConverter]::ToUInt32($entry, 12)
    Write-Host ('  symbol at group 0x{0:X}, offset 0x{1:X}, {2} bytes' -f $ig, $io, $size)
    $value = Send-Request @{ cmd = 'read'; netId = $NetId; port = $Port; ig = $ig; io = $io; len = $size }
    if ($value.ok) {
        $text = [Text.Encoding]::ASCII.GetString([Convert]::FromBase64String($value.data)).Split([char]0)[0]
        Write-Host ('  ProjectName = "{0}"' -f $text)
    }
}

Write-Host '5. latency: 20 ReadState round trips'
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt 20; $i++) {
    $script:nextId++
    $proc.StandardInput.WriteLine(('{{"id":{0},"cmd":"state","netId":"{1}","port":{2}}}' -f $script:nextId, $NetId, $Port))
    $proc.StandardInput.Flush()
    [void]$proc.StandardOutput.ReadLine()
}
$sw.Stop()
Write-Host ('  {0:N1} ms per request on average' -f ($sw.Elapsed.TotalMilliseconds / 20))

Write-Host '6. close'
[void](Send-Request @{ cmd = 'close' })
$proc.StandardInput.Close()
if (-not $proc.WaitForExit(5000)) { $proc.Kill(); Write-Host '  the helper did not exit; killed' } else { Write-Host ('  exit code {0}' -f $proc.ExitCode) }
