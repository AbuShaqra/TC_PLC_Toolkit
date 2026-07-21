# ============================================================================
# TwinCAT 3 - Headless CLI Build via the Automation Interface (DTE COM)
#
# The devenv-style CLI of the XAE Shell crashes on startup ("SyncLock called
# without an initialized synchronization object"), so this script builds through
# the COM Automation Interface instead, which is Beckhoff's documented approach
# for automated builds.
#
# Building with the wrong TwinCAT version fails (or silently upgrades the
# project), and this has TWO independent knobs that must both match the version
# the project was saved with (its .tsproj TcVersion):
#   1. the XAE Shell (DTE ProgId) that is launched, and
#   2. the TwinCAT system version pinned for that shell session via TcRemoteManager.
# The 32-bit 4024 shell can still bind 4026 libraries if the session version is
# not pinned, so both are set automatically from the .tsproj below.
#
# Exit codes: 0 = build succeeded, 1 = build failed, 2 = harness/COM error
# ============================================================================

param(
    # Optional explicit path to the .sln to build. If omitted, the single .sln
    # in the repo root is auto-discovered.
    [string]$SlnPath,
    # Optional DTE ProgId override (e.g. TcXaeShell.DTE.15.0). If omitted, it is
    # derived from the project's TcVersion.
    [string]$ProgId,
    # Optional TwinCAT version to pin (e.g. 3.1.4024.62). If omitted, it is read
    # from the project's .tsproj TcVersion.
    [string]$TcVersion
)

$RepoRoot     = Split-Path -Parent $PSScriptRoot

# TwinCAT build number -> XAE Shell DTE ProgId.
#   4024 = XAE Shell (VS2017 isolated shell, 32-bit)  -> C:\Program Files (x86)\Beckhoff\TcXaeShell
#   4026 = XAE Shell 64 (VS2022 isolated shell, 64-bit) -> C:\Program Files\Beckhoff\TcXaeShell
$ProgIdByBuild = @{
    '4024' = 'TcXaeShell.DTE.15.0'
    '4026' = 'TcXaeShell.DTE.17.0'
}

if (-not $SlnPath) {
    $slns = @(Get-ChildItem -Path $RepoRoot -Filter *.sln -File)
    if ($slns.Count -eq 0) {
        Write-Host "FATAL: no .sln found in repo root: $RepoRoot" -ForegroundColor Red
        exit 2
    }
    if ($slns.Count -gt 1) {
        Write-Host "FATAL: multiple .sln files in repo root - pass one explicitly:" -ForegroundColor Red
        $slns | ForEach-Object { Write-Host "  $($_.Name)" }
        exit 2
    }
    $SlnPath = $slns[0].FullName
}
Write-Host "Solution: $SlnPath" -ForegroundColor Cyan

$ConfigName   = "Release"
$PlatformName = "TwinCAT RT (x64)"

# Read the project's TwinCAT version from its .tsproj and derive both the version
# to pin and the XAE Shell to launch, unless the caller overrode them.
if (-not $TcVersion -or -not $ProgId) {
    $tsproj = Get-ChildItem -Path $RepoRoot -Recurse -Filter *.tsproj -File -ErrorAction SilentlyContinue |
              Sort-Object FullName | Select-Object -First 1
    if (-not $tsproj) {
        Write-Host "FATAL: no .tsproj found under $RepoRoot to read TcVersion from." -ForegroundColor Red
        Write-Host "Pass -TcVersion and -ProgId explicitly." -ForegroundColor Red
        exit 2
    }
    $match = Select-String -Path $tsproj.FullName -Pattern 'TcVersion="(3\.1\.(\d+)\.\d+)"' | Select-Object -First 1
    if (-not $match) {
        Write-Host "FATAL: could not read TcVersion from $($tsproj.Name)." -ForegroundColor Red
        Write-Host "Pass -TcVersion and -ProgId explicitly." -ForegroundColor Red
        exit 2
    }
    if (-not $TcVersion) { $TcVersion = $match.Matches[0].Groups[1].Value }
    if (-not $ProgId) {
        $tcBuild = $match.Matches[0].Groups[2].Value
        if (-not $ProgIdByBuild.ContainsKey($tcBuild)) {
            Write-Host "FATAL: no XAE Shell mapping for TwinCAT build 3.1.$tcBuild." -ForegroundColor Red
            Write-Host "Known builds: $($ProgIdByBuild.Keys -join ', '). Pass -ProgId explicitly." -ForegroundColor Red
            exit 2
        }
        $ProgId = $ProgIdByBuild[$tcBuild]
    }
}
Write-Host "Project TwinCAT version: $TcVersion  ->  shell $ProgId" -ForegroundColor Cyan

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

$dte = $null
try {
    if (-not (Test-Path $SlnPath)) { throw "Solution file not found: $SlnPath" }

    Write-Host "Creating $ProgId instance..." -ForegroundColor Cyan
    $dte = New-Object -ComObject $ProgId
    Invoke-ComRetry { $dte.SuppressUI = $true }
    try { Invoke-ComRetry { $dte.MainWindow.Visible = $false } } catch { }

    # Pin the TwinCAT system version BEFORE opening the solution, so the project
    # builds against the libraries it was saved with rather than the newest version
    # installed. This only applies to the 4026 multi-version XAE Shell; the 4024
    # shell is a single-version install (the shell *is* the version) and exposes no
    # TcRemoteManager version list - touching it there perturbs the solution load,
    # so it is skipped.
    if ($ProgId -eq 'TcXaeShell.DTE.17.0') {
        try {
            $rm = Invoke-ComRetry { $dte.GetObject("TcRemoteManager") }
            $available = @(); try { $available = @(Invoke-ComRetry { $rm.Versions }) } catch { }
            $pin = $TcVersion
            if ($available.Count -gt 0 -and ($available -notcontains $TcVersion)) {
                $build = ($TcVersion -split '\.')[2]
                $sameBuild = $available | Where-Object { ($_ -split '\.')[2] -eq $build } | Sort-Object { [version]$_ } -Descending
                if (-not $sameBuild) { throw "No installed TwinCAT $build.x version. Installed: $($available -join ', ')" }
                $pin = @($sameBuild)[0]
                Write-Host "Exact $TcVersion not installed; using nearest same-build $pin" -ForegroundColor Yellow
            }
            Invoke-ComRetry { $rm.Version = $pin }
            Write-Host "Pinned TwinCAT version: $pin" -ForegroundColor Cyan
        } catch {
            Write-Host "WARNING: TcRemoteManager version pin skipped: $_" -ForegroundColor Yellow
        }
    } else {
        Write-Host "Single-version shell ($ProgId); TwinCAT version fixed by the shell." -ForegroundColor DarkGray
    }

    Write-Host "Opening solution (loads the TwinCAT project, may take a while)..." -ForegroundColor Cyan
    Invoke-ComRetry { $dte.Solution.Open($SlnPath) }

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
        try { $dte.Quit() } catch { }
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dte) | Out-Null
    }
}
exit $exitCode
