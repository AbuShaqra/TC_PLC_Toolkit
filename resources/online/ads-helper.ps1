# TC Toolkit online monitoring (roadmap R15 phase 2): the user-mode fallback's ADS helper.
# Started by src/online/adsHelperProcess.js as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ads-helper.ps1 -TimeoutMs 2000
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
<#
.SYNOPSIS
    Raw ADS through Beckhoff's installed TwinCAT.Ads.dll, as JSON lines on stdin/stdout.

.DESCRIPTION
    The TwinCAT 3.1.4026 user-mode router resets the TCP connection the extension's ADS library opens
    to 127.0.0.1:48898, while Beckhoff's own .NET stack (TwinCAT.Ads.dll over TcAdsDll.dll) still
    reaches the runtime through it. This helper is that stack, nothing more: it answers raw ADS
    requests (Read, Write, ReadWrite, ReadState, ReadDeviceInfo by AMS NetId, port, index group and
    offset). Symbols, data types and values are decoded by the extension, exactly as on its own path.

    Protocol: one JSON object per line.
      At start, one line:  {"id":0,"event":"ready","ok":true,"dll":"...","dllVersion":"...","bitness":64,"common":"..."}
                       or  {"id":0,"event":"ready","ok":false,"kind":"dll-not-found"|"dll-load","error":"...","searched":[...]}
      Requests:            {"id":N,"cmd":"open","netId":"10.0.0.4.1.1","port":851}
                           {"id":N,"cmd":"read","netId":...,"port":...,"ig":16448,"io":0,"len":4}
                           {"id":N,"cmd":"write","netId":...,"port":...,"ig":...,"io":...,"data":"<base64>"}
                           {"id":N,"cmd":"readwrite","netId":...,"port":...,"ig":...,"io":...,"len":...,"data":"<base64>"}
                           {"id":N,"cmd":"state","netId":...,"port":...}
                           {"id":N,"cmd":"deviceinfo","netId":...,"port":...}
                           {"id":N,"cmd":"close"}
      Answers:             {"id":N,"ok":true, ...result}    open: localNetId, localPort; read/readwrite: data;
                                                            state: adsState, deviceState;
                                                            deviceinfo: name, major, minor, build
                           {"id":N,"ok":false,"error":"...","adsError":7}   (adsError only for an ADS error)
    The helper exits when stdin closes (or after "close"). One TcAdsClient per NetId:port is kept.
    A NetId of 127.0.0.1.1.1 or "localhost" connects to the local router (TcAdsClient.Connect(port)).

.PARAMETER TimeoutMs
    TcAdsClient.Timeout for every request, in milliseconds.

.PARAMETER AdsDll
    Use this TwinCAT.Ads.dll instead of searching for one (for the manual smoke test).

.EXAMPLE
    '{"id":1,"cmd":"state","netId":"10.0.0.4.1.1","port":10000}' | powershell -NoProfile -ExecutionPolicy Bypass -File ads-helper.ps1
#>
param(
    [int]$TimeoutMs = 2000,
    [string]$AdsDll = ''
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

function Write-Message([hashtable]$Message) {
    [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

# --- Finding TwinCAT.Ads.dll ------------------------------------------------------------------------
# Roots that may hold "3.1\Components\Base\v*\TwinCAT.Ads.dll": the install folders the registry names
# (the value names differ between builds, so all known ones are read), then the default locations.
function Get-TwinCatRoots {
    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($key in @('HKLM:\SOFTWARE\WOW6432Node\Beckhoff\TwinCAT3', 'HKLM:\SOFTWARE\Beckhoff\TwinCAT3')) {
        try {
            $p = Get-ItemProperty -Path $key -ErrorAction Stop
            foreach ($name in @('InstallDir', 'TwinCATDir', 'TwinCAT3Dir')) {
                $v = $p.$name
                if ($v) { $roots.Add(([string]$v).TrimEnd('\')) }
            }
        } catch { }
    }
    $x86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($x86) { $roots.Add((Join-Path $x86 'Beckhoff\TwinCAT')) }
    $roots.Add('C:\TwinCAT')
    $seen = @{}
    foreach ($r in $roots) {
        # A value may name the TwinCAT folder or its 3.1 subfolder; the root is the folder above 3.1.
        $root = $r
        if ((Split-Path -Leaf $root) -eq '3.1') { $root = Split-Path -Parent $root }
        if ($root -and -not $seen.ContainsKey($root.ToLowerInvariant())) {
            $seen[$root.ToLowerInvariant()] = $true
            $root
        }
    }
}

# Every TwinCAT.Ads.dll under the roots, newest Components\Base\v<N> first, each with its TwinCAT root.
function Get-AdsDllCandidates {
    foreach ($root in Get-TwinCatRoots) {
        $base = Join-Path $root '3.1\Components\Base'
        if (-not (Test-Path -LiteralPath $base)) { continue }
        Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^v(\d+)$' } |
            Sort-Object { [int]($_.Name.Substring(1)) } -Descending |
            ForEach-Object {
                $dll = Join-Path $_.FullName 'TwinCAT.Ads.dll'
                if (Test-Path -LiteralPath $dll) { [pscustomobject]@{ Dll = $dll; Root = $root } }
            }
    }
}

$bitness = if ([Environment]::Is64BitProcess) { 64 } else { 32 }
$commonName = if ($bitness -eq 64) { 'Common64' } else { 'Common32' }
$searched = New-Object System.Collections.Generic.List[string]
$loaded = $null
$loadErrors = New-Object System.Collections.Generic.List[string]

$candidates = @()
if ($AdsDll) {
    $root = $null
    $dir = Split-Path -Parent $AdsDll
    while ($dir -and -not (Test-Path -LiteralPath (Join-Path $dir $commonName))) { $dir = Split-Path -Parent $dir }
    $candidates = @([pscustomobject]@{ Dll = $AdsDll; Root = $dir })
} else {
    $candidates = @(Get-AdsDllCandidates)
    foreach ($r in Get-TwinCatRoots) { $searched.Add((Join-Path $r '3.1\Components\Base\v*\TwinCAT.Ads.dll')) }
}

foreach ($c in $candidates) {
    # TcAdsDll.dll lives in Common64 (or Common32 for a 32-bit PowerShell); TwinCAT.Ads.dll P/Invokes it.
    $common = if ($c.Root) { Join-Path $c.Root $commonName } else { $null }
    $oldPath = $env:Path
    if ($common -and (Test-Path -LiteralPath $common)) { $env:Path = $common + ';' + $env:Path } else { $common = $null }
    try {
        Add-Type -Path $c.Dll
        if (-not ('TwinCAT.Ads.TcAdsClient' -as [type])) { throw 'it has no TwinCAT.Ads.TcAdsClient type' }
        $loaded = [pscustomobject]@{ Dll = $c.Dll; Common = $common }
        break
    } catch {
        $loadErrors.Add(('{0}: {1}' -f $c.Dll, $_.Exception.Message))
        $env:Path = $oldPath
    }
}

if (-not $loaded) {
    if ($candidates.Count -eq 0) {
        Write-Message @{ id = 0; event = 'ready'; ok = $false; kind = 'dll-not-found'; bitness = $bitness;
            error = 'TwinCAT.Ads.dll was not found (TwinCAT 3.1 XAE or XAR installs it under Components\Base).'; searched = @($searched) }
    } else {
        Write-Message @{ id = 0; event = 'ready'; ok = $false; kind = 'dll-load'; bitness = $bitness;
            error = ('TwinCAT.Ads.dll did not load: ' + ($loadErrors -join '; ')); searched = @($candidates | ForEach-Object { $_.Dll }) }
    }
    exit 2
}

$dllVersion = ''
try { $dllVersion = [Reflection.AssemblyName]::GetAssemblyName($loaded.Dll).Version.ToString() } catch { }
Write-Message @{ id = 0; event = 'ready'; ok = $true; dll = $loaded.Dll; dllVersion = $dllVersion; bitness = $bitness; common = $loaded.Common }

# --- Requests -----------------------------------------------------------------------------------------
$clients = @{}

function Get-AdsClient($Request) {
    $netId = [string]$Request.netId
    $port = [int]$Request.port
    $key = '{0}:{1}' -f $netId, $port
    if ($clients.ContainsKey($key)) { return $clients[$key] }
    $client = New-Object TwinCAT.Ads.TcAdsClient
    $client.Timeout = $TimeoutMs
    if (-not $netId -or $netId -eq '127.0.0.1.1.1' -or $netId -eq 'localhost') { $client.Connect($port) }
    else { $client.Connect($netId, $port) }
    $clients[$key] = $client
    return $client
}

function New-Stream([int]$Length) { return New-Object TwinCAT.Ads.AdsStream -ArgumentList $Length }

# A stream holding the bytes, positioned at 0 (whichever of position or offset TcAdsClient reads from).
function New-StreamFrom([byte[]]$Bytes) {
    $s = New-Stream $Bytes.Length
    $s.Write($Bytes, 0, $Bytes.Length)
    $s.Position = 0
    return $s
}

# The comma keeps PowerShell from unrolling the array into its bytes (or an empty one into $null).
function Get-Bytes($Request) {
    if ($Request.data) { return ,([Convert]::FromBase64String([string]$Request.data)) }
    return ,(New-Object byte[] 0)
}

function Invoke-AdsRequest($Request) {
    switch ([string]$Request.cmd) {
        'open' {
            $c = Get-AdsClient $Request
            return @{ localNetId = $c.ClientAddress.NetId.ToString(); localPort = [int]$c.ClientAddress.Port }
        }
        'read' {
            $c = Get-AdsClient $Request
            $len = [int]$Request.len
            $rd = New-Stream $len
            $n = $c.Read([long]$Request.ig, [long]$Request.io, $rd, 0, $len)
            return @{ data = [Convert]::ToBase64String($rd.ToArray(), 0, [int]$n) }
        }
        'write' {
            $c = Get-AdsClient $Request
            $bytes = Get-Bytes $Request
            $wr = New-StreamFrom $bytes
            $c.Write([long]$Request.ig, [long]$Request.io, $wr, 0, $bytes.Length)
            return @{ }
        }
        'readwrite' {
            $c = Get-AdsClient $Request
            $len = [int]$Request.len
            $bytes = Get-Bytes $Request
            $rd = New-Stream $len
            $wr = New-StreamFrom $bytes
            $n = $c.ReadWrite([long]$Request.ig, [long]$Request.io, $rd, 0, $len, $wr, 0, $bytes.Length)
            return @{ data = [Convert]::ToBase64String($rd.ToArray(), 0, [int]$n) }
        }
        'state' {
            $c = Get-AdsClient $Request
            $s = $c.ReadState()
            return @{ adsState = [int]$s.AdsState; deviceState = [int]$s.DeviceState }
        }
        'deviceinfo' {
            $c = Get-AdsClient $Request
            $d = $c.ReadDeviceInfo()
            return @{ name = [string]$d.Name; major = [int]$d.Version.Version; minor = [int]$d.Version.Revision; build = [int]$d.Version.Build }
        }
        'close' { return @{ closing = $true } }
        default { throw ('unknown command "{0}"' -f $Request.cmd) }
    }
}

# The ADS error code of a failure: TwinCAT.Ads throws AdsErrorException (ErrorCode), which PowerShell
# wraps in a MethodInvocationException; walk the inner exceptions for the first TwinCAT.Ads one that
# has it (a Win32Exception's ErrorCode is not an ADS code).
function Get-AdsErrorCode($Exception) {
    $e = $Exception
    while ($e) {
        $p = $null
        if ($e.GetType().FullName -like 'TwinCAT.Ads.*') { $p = $e.PSObject.Properties['ErrorCode'] }
        if ($p -and $null -ne $p.Value) { try { return [int]$p.Value } catch { } }
        $e = $e.InnerException
    }
    return $null
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $id = $null
    $closing = $false
    try {
        $request = $line | ConvertFrom-Json
        $id = $request.id
        $result = Invoke-AdsRequest $request
        $closing = [string]$request.cmd -eq 'close'
        $result.id = $id
        $result.ok = $true
        Write-Message $result
    } catch {
        $answer = @{ id = $id; ok = $false; error = $_.Exception.Message }
        $code = Get-AdsErrorCode $_.Exception
        if ($null -ne $code) { $answer.adsError = $code }
        Write-Message $answer
    }
    if ($closing) { break }
}

foreach ($c in $clients.Values) { try { $c.Dispose() } catch { } }
exit 0
