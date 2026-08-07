<#
.SYNOPSIS
    Diagnostic: can the TwinCAT system manager be reached over the DTE the builder creates?

.DESCRIPTION
    build_plc_project.ps1 drives the IDE one way and build-sample-solution.ps1 drives it another, and
    the two disagree in writing:

      build-sample-solution.ps1  Start-Process + ROT-lookup-by-PID, IOleMessageFilter always
                                 registered, message queue pumped in every wait. Its header states
                                 that `New-Object -ComObject` "yields a null Solution forever" and
                                 that without a pump "the DTE never finishes initialising".
      build_plc_project.ps1      New-Object -ComObject, NO pump anywhere, message filter registered
                                 only when -TcVersion is passed.

    Building demonstrably works the second way. Whether a SYSTEM MANAGER can be obtained that way -
    and whether a long blocking ActivateConfiguration() survives it - is unverified, and everything
    the activation feature does rests on the answer.

    This script settles it by measurement. It reproduces the builder's acquisition path exactly and
    then probes. It does NOT activate unless -ReallyActivate is passed.

.PARAMETER Solution
    Solution to open. Same forgiving forms as the builder: bare name, path, or a directory.

.PARAMETER TcVersion
    Passed through to decide the shell, and - as in the builder - its PRESENCE is what registers the
    IOleMessageFilter. Use it to isolate whether the filter matters.

.PARAMETER Pump
    Pump the Windows message queue while waiting, the way build-sample-solution.ps1 does. Use it to
    isolate whether the pump matters.

.PARAMETER ReallyActivate
    Actually call ActivateConfiguration() and StartRestartTwinCAT(). OFF by default.
    RUN THIS ONLY AGAINST A SANDBOX CLONE - it restarts the local TwinCAT runtime.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\probe-sysmanager.ps1" -Solution TcSample
#>

param(
    [Parameter(Position = 0)]
    [string]$Solution,
    [string]$TcVersion,
    [switch]$Pump,
    [switch]$ReallyActivate
)

$ErrorActionPreference = 'Continue'
$script:results = @()

function Report {
    param([string]$Id, [string]$What, [bool]$Ok, [string]$Detail, [int]$Ms = -1)
    $script:results += [pscustomobject]@{ Id = $Id; What = $What; Ok = $Ok; Detail = $Detail; Ms = $Ms }
    $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
    $col = if ($Ok) { 'Green' } else { 'Red' }
    $time = if ($Ms -ge 0) { "{0,7} ms" -f $Ms } else { '          ' }
    Write-Host ("  {0}  {1}  {2,-46} {3}" -f $tag, $time, $What, $Detail) -ForegroundColor $col
}

function Resolve-RepoRoot {
    param([Parameter(Mandatory)][string]$From)
    $dir = $From
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $dir }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return (Split-Path -Parent $From)
}

$RepoRoot = Resolve-RepoRoot -From $PSScriptRoot
$ProgIdByBuild = @{ '4024' = 'TcXaeShell.DTE.15.0'; '4026' = 'TcXaeShell.DTE.17.0' }

# ---- resolve the solution -------------------------------------------------------------------
if (-not $Solution) {
    $slns = @(Get-ChildItem -Path $RepoRoot -Recurse -Filter *.sln -File -ErrorAction SilentlyContinue | Sort-Object FullName)
    if ($slns.Count -ne 1) {
        Write-Host "FATAL: name a solution - found $($slns.Count) under $RepoRoot" -ForegroundColor Red
        $slns | ForEach-Object { Write-Host "  $($_.FullName)" }
        exit 2
    }
    $SlnPath = $slns[0].FullName
} elseif ((Test-Path -LiteralPath $Solution -PathType Leaf) -and ([IO.Path]::GetExtension($Solution) -eq '.sln')) {
    $SlnPath = (Resolve-Path -LiteralPath $Solution).Path
} else {
    $leaf = [IO.Path]::GetFileNameWithoutExtension($Solution)
    $hit = @(Get-ChildItem -Path $RepoRoot -Recurse -Filter "$leaf.sln" -File -ErrorAction SilentlyContinue)
    if ($hit.Count -ne 1) { Write-Host "FATAL: '$Solution' matched $($hit.Count) solutions." -ForegroundColor Red; exit 2 }
    $SlnPath = $hit[0].FullName
}

$slnDir = Split-Path -Parent $SlnPath
$tsproj = Get-ChildItem -Path $slnDir -Recurse -Filter *.tsproj -File -ErrorAction SilentlyContinue |
          Sort-Object FullName | Select-Object -First 1
if (-not $tsproj) { Write-Host "FATAL: no .tsproj under $slnDir" -ForegroundColor Red; exit 2 }
$m = Select-String -Path $tsproj.FullName -Pattern 'TcVersion="(3\.1\.(\d+)\.\d+)"' | Select-Object -First 1
if (-not $m) { Write-Host "FATAL: no TcVersion in $($tsproj.Name)" -ForegroundColor Red; exit 2 }
$projectVersion = $m.Matches[0].Groups[1].Value
$build          = $m.Matches[0].Groups[2].Value
if (-not $TcVersion) { $effVersion = $projectVersion } else { $effVersion = $TcVersion }
$effBuild = ($effVersion -split '\.')[2]
$ProgId   = $ProgIdByBuild[$effBuild]
if (-not $ProgId) { Write-Host "FATAL: no shell for build $effBuild" -ForegroundColor Red; exit 2 }

Write-Host ""
Write-Host "=== probe-sysmanager ===" -ForegroundColor Magenta
Write-Host "  Solution        : $SlnPath"
Write-Host "  Project version : $projectVersion  (from $($tsproj.Name))"
Write-Host "  Driving shell   : $ProgId"
Write-Host "  Message filter  : $(if ($TcVersion) { 'YES (-TcVersion given)' } else { 'no' })"
Write-Host "  Message pump    : $(if ($Pump) { 'YES' } else { 'no' })"
Write-Host "  Will activate   : $(if ($ReallyActivate) { 'YES - restarts the local runtime' } else { 'no' })" -ForegroundColor $(if ($ReallyActivate) { 'Yellow' } else { 'DarkGray' })
Write-Host "  Apartment       : $([System.Threading.Thread]::CurrentThread.GetApartmentState())"
Write-Host ""

# ---- optional pump, copied in shape from build-sample-solution.ps1 --------------------------
if ($Pump) { Add-Type -AssemblyName System.Windows.Forms }
function Wait-Bit {
    param([int]$Ms)
    if ($Pump) {
        $end = (Get-Date).AddMilliseconds($Ms)
        while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
    } else {
        Start-Sleep -Milliseconds $Ms
    }
}

function Invoke-ComRetry {
    param([scriptblock]$Action, [int]$MaxTries = 30, [int]$DelaySec = 2)
    for ($try = 1; $try -le $MaxTries; $try++) {
        try { return (& $Action) }
        catch {
            if ($_.Exception.ToString() -match '80010001|RPC_E_CALL_REJECTED|80010100|RPC_E_SERVERCALL') { Wait-Bit ($DelaySec * 1000) }
            else { throw }
        }
    }
    throw "COM call still rejected after $MaxTries tries."
}

# ---- message filter, registered exactly when the builder would ------------------------------
$filterRegistered = $false
if ($TcVersion -and [System.Threading.Thread]::CurrentThread.GetApartmentState() -eq 'STA') {
    if (-not ('TcProbeMessageFilter' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TcProbeMessageFilter : IOleMessageFilter {
    [DllImport("Ole32.dll")] private static extern int CoRegisterMessageFilter(IOleMessageFilter n, out IOleMessageFilter o);
    public static void Register() { IOleMessageFilter o = null; CoRegisterMessageFilter(new TcProbeMessageFilter(), out o); }
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
    [TcProbeMessageFilter]::Register()
    $filterRegistered = $true
}

$dte = $null
$ownShellPid = $null
$sw = [System.Diagnostics.Stopwatch]::new()

try {
    $before = @(Get-Process -Name TcXaeShell -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    Write-Host "Creating $ProgId ..." -ForegroundColor Cyan
    $sw.Restart()
    $dte = New-Object -ComObject $ProgId
    Report 'S0' 'DTE created' $true '' $sw.ElapsedMilliseconds

    for ($i = 0; $i -lt 40 -and -not $ownShellPid; $i++) {
        $new = @(Get-Process -Name TcXaeShell -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty Id | Where-Object { $before -notcontains $_ })
        if ($new.Count -eq 1) { $ownShellPid = $new[0]; break }
        if ($new.Count -gt 1) { break }
        Wait-Bit 500
    }
    Write-Host "  our shell PID: $(if ($ownShellPid) { $ownShellPid } else { '<unidentified>' })" -ForegroundColor DarkGray

    Invoke-ComRetry { $dte.SuppressUI = $true }

    # ---- open the solution, as the builder does ---------------------------------------------
    $sw.Restart()
    $opened = $false
    for ($i = 0; $i -lt 25 -and -not $opened; $i++) {
        try { Invoke-ComRetry { $dte.Solution.Open($SlnPath) }; $opened = $true } catch { Wait-Bit 3000 }
    }
    Report 'S0b' 'Solution.Open' $opened '' $sw.ElapsedMilliseconds
    if (-not $opened) { throw "could not open the solution" }

    $sw.Restart()
    $projCount = 0
    for ($i = 0; $i -lt 120; $i++) {
        $isOpen = Invoke-ComRetry { $dte.Solution.IsOpen }
        $projCount = Invoke-ComRetry { $dte.Solution.Projects.Count }
        if ($isOpen -and $projCount -gt 0) { break }
        Wait-Bit 2000
    }
    Report 'S0c' 'Solution.Projects.Count > 0' ($projCount -gt 0) "count=$projCount" $sw.ElapsedMilliseconds

    # ---- S1: the sysmanager ------------------------------------------------------------------
    # Pattern from build-sample-solution.ps1: iterate Projects, take .Object, probe LookupTreeItem('TIPC').
    # Identity by CAPABILITY, not index - a solution can hold more than one project.
    $sw.Restart()
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
        if ($null -eq $sysManager) { Wait-Bit 500 }
    }
    Report 'S1' 'sysmanager via .Object + LookupTreeItem(TIPC)' ($null -ne $sysManager) '' $sw.ElapsedMilliseconds
    if (-not $sysManager) { throw "no usable system manager - this is the answer the spike existed to get" }

    # ---- S2: the target NetId ----------------------------------------------------------------
    $targetNetId = $null
    try {
        $sw.Restart()
        $targetNetId = "$(Invoke-ComRetry { $sysManager.GetTargetNetId() })"
        Report 'S2' 'GetTargetNetId()' ($targetNetId -ne '') "[$targetNetId]" $sw.ElapsedMilliseconds
    } catch { Report 'S2' 'GetTargetNetId()' $false "threw: $($_.Exception.Message)" }

    # ---- S3: a deliberate no-op set, then readback -------------------------------------------
    if ($targetNetId) {
        try {
            $sw.Restart()
            Invoke-ComRetry { $sysManager.SetTargetNetId($targetNetId) }
            $back = "$(Invoke-ComRetry { $sysManager.GetTargetNetId() })"
            Report 'S3' 'SetTargetNetId(current) round-trips' ($back -eq $targetNetId) "readback=[$back]" $sw.ElapsedMilliseconds
        } catch { Report 'S3' 'SetTargetNetId(current)' $false "threw: $($_.Exception.Message)" }
    }

    # ---- S4: which members exist -------------------------------------------------------------
    Write-Host ""
    Write-Host "  --- member probe (IDispatch::GetIDsOfNames - does NOT invoke) ---" -ForegroundColor DarkMagenta
    # Existence is asked, never tested by calling: invoking ActivateConfiguration() to find out
    # whether it exists would ACTIVATE. GetIDsOfNames answers the same question for free and is
    # locale-independent - unlike catching a localized "no method named X" message.
    if (-not ('TcDispProbe' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("00020400-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDispatchProbe {
    [PreserveSig] int GetTypeInfoCount(out uint pctinfo);
    [PreserveSig] int GetTypeInfo(uint iTInfo, uint lcid, out IntPtr ppTInfo);
    [PreserveSig] int GetIDsOfNames(ref Guid riid,
        [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] rgszNames,
        uint cNames, uint lcid, [MarshalAs(UnmanagedType.LPArray)] int[] rgDispId);
}
public static class TcDispProbe {
    // S_OK => the name resolves to a dispid. DISP_E_UNKNOWNNAME (0x80020006) => it does not exist.
    public static int DispIdOf(object com, string name) {
        IDispatchProbe d = com as IDispatchProbe;
        if (d == null) { return -2; }
        Guid iid = Guid.Empty;
        int[] ids = new int[1];
        int hr = d.GetIDsOfNames(ref iid, new string[] { name }, 1, 1033, ids);
        if (hr == 0) { return ids[0]; }
        return hr;
    }
}
'@
    }
    foreach ($name in 'GetTargetNetId','SetTargetNetId','ActivateConfiguration','StartRestartTwinCAT','IsTwinCatStarted','SaveConfiguration','ProduceMappingInfo','GetTargetVersion','ActivateConfigurationEx','RestartTwinCAT',
                      'GetTargetState','SetTargetState','GetAdsState','GetDeviceState','SetAppState','GetAppState','TargetState','GetTargetSystemState','SwitchTargetToRunMode','SwitchTargetToConfigMode') {
        $id = -3
        try { $id = [TcDispProbe]::DispIdOf($sysManager, $name) } catch { }
        if ($id -ge 0) {
            Write-Host ("    {0,-26} present  (dispid {1})" -f $name, $id) -ForegroundColor Gray
        } elseif ($id -eq -2147352570) {   # 0x80020006 DISP_E_UNKNOWNNAME
            Write-Host ("    {0,-26} MISSING" -f $name) -ForegroundColor DarkYellow
        } else {
            Write-Host ("    {0,-26} indeterminate (hr=0x{1:X8})" -f $name, $id) -ForegroundColor DarkYellow
        }
    }

    # ---- S4c: what does IsTwinCatStarted ACTUALLY return? ------------------------------------
    # This matters more than it looks. A run reported ACTIVATION SUCCEEDED on a system that was in
    # CONFIG mode the whole time, because the result was tested with `if ($x)`. If the value is not
    # a Boolean, PowerShell truthiness makes almost anything pass - a non-zero state code, a COM
    # object, a non-empty string. Print the value AND its type before trusting it again.
    Write-Host ""
    Write-Host "  --- run-state probe ---" -ForegroundColor DarkMagenta
    try {
        $v = Invoke-ComRetry { $sysManager.IsTwinCatStarted() }
        $t = if ($null -eq $v) { '<null>' } else { $v.GetType().FullName }
        Write-Host ("    IsTwinCatStarted() = [{0}]  type={1}  -as-bool={2}" -f $v, $t, [bool]$v) -ForegroundColor Cyan
    } catch { Write-Host "    IsTwinCatStarted() threw: $($_.Exception.Message)" -ForegroundColor Yellow }
    $ssRaw = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Beckhoff\TwinCAT3\System' -ErrorAction SilentlyContinue).SysStartupState
    $adsNames = @{ 0='INVALID';1='IDLE';2='RESET';3='INIT';4='START';5='RUN';6='STOP';7='SAVECFG';8='LOADCFG';
                   9='POWERFAILURE';10='POWERGOOD';11='ERROR';12='SHUTDOWN';13='SUSPEND';14='RESUME';15='CONFIG';16='RECONFIG' }
    Write-Host ("    registry SysStartupState = {0} ({1})" -f $ssRaw, $adsNames[[int]$ssRaw]) -ForegroundColor Cyan

    # The authoritative answer: ask ADS for the system service's state. TcAdsDll ships with TwinCAT,
    # which this script already requires, so this is not a new dependency. This is the ONLY reading
    # that distinguishes RUN (5) from CONFIG (15/16) - the sysmanager exposes no state member at all,
    # and IsTwinCatStarted is true in Config, which is how a Config-mode system was once reported as
    # successfully activated.
    if (-not ('TcAds' -as [type])) {
        $adsDir = 'C:\Program Files (x86)\Beckhoff\TwinCAT\Common64'
        if (Test-Path -LiteralPath (Join-Path $adsDir 'TcAdsDll.dll')) {
            $env:PATH = "$adsDir;$env:PATH"
            Add-Type @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct AmsAddr { [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] netId; public ushort port; }
public static class TcAds {
    [DllImport("TcAdsDll.dll")] public static extern int AdsPortOpen();
    [DllImport("TcAdsDll.dll")] public static extern int AdsPortClose();
    [DllImport("TcAdsDll.dll")] public static extern int AdsSyncReadStateReq(ref AmsAddr pAddr, ref ushort pAdsState, ref ushort pDeviceState);
}
'@
        }
    }
    if ('TcAds' -as [type]) {
        # The second candidate is a placeholder (RFC 5737 TEST-NET-2) for a known-good NetId to
        # cross-check against during interactive debugging - swap in a real local target if needed.
        foreach ($probeNet in @($targetNetId, '198.51.100.4.1.1' | Where-Object { $_ } | Select-Object -Unique)) {
            try {
                $addr = New-Object AmsAddr
                $addr.netId = [byte[]]($probeNet -split '\.' | ForEach-Object { [byte]$_ })
                $addr.port  = 10000          # AMSPORT_R0_SYSTEMSERVICE
                [void][TcAds]::AdsPortOpen()
                $ads = [uint16]0; $dev = [uint16]0
                $hr = [TcAds]::AdsSyncReadStateReq([ref]$addr, [ref]$ads, [ref]$dev)
                [void][TcAds]::AdsPortClose()
                if ($hr -eq 0) {
                    $nm = $adsNames[[int]$ads]
                    $isRun = ($ads -eq 5)
                    Write-Host ("    ADS state of {0}:10000 = {1} ({2})   RUN? {3}" -f $probeNet, $ads, $nm, $isRun) `
                        -ForegroundColor $(if ($isRun) { 'Green' } else { 'Yellow' })
                } else {
                    Write-Host ("    ADS state of {0}:10000 -> error 0x{1:X}" -f $probeNet, $hr) -ForegroundColor DarkYellow
                }
            } catch { Write-Host "    ADS probe of $probeNet threw: $($_.Exception.Message)" -ForegroundColor DarkYellow }
        }
    } else {
        Write-Host "    TcAdsDll not found - cannot read the real ADS state" -ForegroundColor DarkYellow
    }

    # ---- S4b: how is the target PLATFORM exposed? --------------------------------------------
    # XAE prompts when the solution's platform does not match the runtime's, so the information is
    # reachable somehow. Dump what we can find rather than guessing an API name.
    Write-Host ""
    Write-Host "  --- platform discovery ---" -ForegroundColor DarkMagenta
    # NOTE: tree item NAMES are localized - this machine reports 'Echtzeit' for TIRS - so never match
    # on them. Only shortcuts and XML content are stable.
    try {
        $tv = "$(Invoke-ComRetry { $sysManager.GetTargetVersion() })"
        Write-Host ("    GetTargetVersion()        -> [{0}]" -f $tv) -ForegroundColor Gray
    } catch { Write-Host "    GetTargetVersion()        -> threw: $($_.Exception.Message)" -ForegroundColor DarkGray }

    $dumpDir = Join-Path $env:TEMP 'tc-probe-xml'
    New-Item -ItemType Directory -Path $dumpDir -Force | Out-Null
    foreach ($shortcut in 'TIRC','TIRT','TIRS','TISC','TIPC') {
        try {
            $item = $sysManager.LookupTreeItem($shortcut)
            $name = $item.Name
            $xml = $null
            try { $xml = $item.ProduceXml() } catch { }
            if ($xml) {
                $out = Join-Path $dumpDir "$shortcut.xml"
                Set-Content -LiteralPath $out -Value $xml -Encoding UTF8
                $hit = ([regex]'(?i)(TwinCAT (RT|OS) \([^)]{1,20}\)|\bx64\b|\bx86\b|ARMV[78][A-Z-]*|amd64|AMD64)').Matches($xml) |
                       ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 10
                Write-Host ("    {0,-5} '{1}'  xml={2} bytes -> {3}" -f $shortcut, $name, $xml.Length, $out) -ForegroundColor Gray
                if ($hit) { Write-Host ("            tokens: {0}" -f ($hit -join ', ')) -ForegroundColor Cyan }
            } else {
                Write-Host ("    {0,-5} '{1}'  (ProduceXml unavailable)" -f $shortcut, $name) -ForegroundColor DarkGray
            }
        } catch { Write-Host ("    {0,-5} not available" -f $shortcut) -ForegroundColor DarkGray }
    }

    # ---- S5: the real thing, opt-in only -----------------------------------------------------
    if ($ReallyActivate) {
        Write-Host ""
        Write-Host "  ACTIVATING - the XAE window is made visible so any dialog can be answered." -ForegroundColor Yellow
        try { Invoke-ComRetry { $dte.SuppressUI = $false } } catch { }
        try { Invoke-ComRetry { $dte.MainWindow.Visible = $true } } catch { }

        try {
            $sw.Restart()
            Invoke-ComRetry { $sysManager.ActivateConfiguration() }
            Report 'S5a' 'ActivateConfiguration()' $true '' $sw.ElapsedMilliseconds
        } catch { Report 'S5a' 'ActivateConfiguration()' $false "threw: $($_.Exception.Message)" $sw.ElapsedMilliseconds }

        try {
            $sw.Restart()
            Invoke-ComRetry { $sysManager.StartRestartTwinCAT() }
            Report 'S5b' 'StartRestartTwinCAT()' $true '' $sw.ElapsedMilliseconds
        } catch { Report 'S5b' 'StartRestartTwinCAT()' $false "threw: $($_.Exception.Message)" $sw.ElapsedMilliseconds }
    }
}
catch {
    Write-Host "FATAL: $_" -ForegroundColor Red
}
finally {
    if ($dte) {
        try { $dte.Solution.Close($false) } catch { }
        if ($ownShellPid -and (Get-Process -Id $ownShellPid -ErrorAction SilentlyContinue)) {
            try { $dte.Quit() } catch { }
        } else {
            Write-Host "NOTE: leaving the XAE Shell open - could not prove which process it is." -ForegroundColor DarkGray
        }
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dte) | Out-Null
    }
    if ($filterRegistered) { try { [TcProbeMessageFilter]::Revoke() } catch { } }
}

Write-Host ""
Write-Host "=== summary ===" -ForegroundColor Magenta
$script:results | ForEach-Object {
    Write-Host ("  {0,-5} {1,-46} {2}" -f $_.Id, $_.What, $(if ($_.Ok) { 'PASS' } else { 'FAIL' })) -ForegroundColor $(if ($_.Ok) { 'Green' } else { 'Red' })
}
$failed = @($script:results | Where-Object { -not $_.Ok }).Count
Write-Host ""
Write-Host "  $($script:results.Count) checks, $failed failed" -ForegroundColor $(if ($failed) { 'Yellow' } else { 'Green' })
exit $(if ($failed) { 1 } else { 0 })
