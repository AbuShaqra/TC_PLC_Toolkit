<#
.SYNOPSIS
    Creates an authentic, EMPTY TwinCAT solution + PLC project skeleton at the repo root, by driving
    TcXaeShell's automation interface (DTE) exactly once.

.DESCRIPTION
    scripts/build-sample-project.js writes the sample's 19 PLC objects and a hand-authored `.plcproj`.
    That is not a project XAE Shell can open: a TwinCAT PLC project is not a standalone `.plcproj`, it is

        <Solution>.sln            <- the Visual Studio solution
        <Solution>.tsproj         <- the TwinCAT SYSTEM project (the thing XAE actually opens)
        <PlcProject>\<PlcProject>.plcproj

    and only TwinCAT itself knows how to write the `.tsproj`/`.sln` pair correctly (the template on disk
    is a 67-byte stub -- `<TcSmProject><Project/></TcSmProject>` -- that TwinCAT expands at insertion
    time). Hand-writing them is how we got a project XAE refuses to open in the first place.

    So this script is a ONE-SHOT generator: it runs the IDE once, creates the solution, inserts the
    TwinCAT system project and an empty PLC project from the standard template, saves everything to
    disk, and quits. The result is committed, and the sample's objects are filled in afterwards. It is
    developer tooling -- nothing in the extension calls it, and it is never run by a user.

    HOW IT DRIVES THE IDE
    ---------------------
    All of the COM plumbing below is COPIED, essentially verbatim, from
    scripts/generate-library-signatures.ps1, whose header documents why each step exists. Every one of
    them was established empirically -- do not "simplify" them away, and KEEP THE TWO SCRIPTS IN SYNC:

      * Windows PowerShell 5.1 in **-STA** mode. COM interop into the DTE needs a single-threaded
        apartment. (This script hard-checks it at startup rather than trusting the caller.)
      * An **IOleMessageFilter** must be registered, or a busy IDE rejects our calls outright.
        RetryRejectedCall must return a retry delay for SERVERCALL_RETRYLATER (dwRejectType == 2) and
        -1 (cancel) otherwise -- inverting that is a hang.
      * Every wait loop must pump the message queue (`Application::DoEvents`). WITHOUT a pump the DTE
        never finishes initialising and `$dte.Solution` stays null forever.
      * The shell is launched as a NORMAL process and then attached through the Running Object Table.
        A COM `-Embedding` activation (`New-Object -ComObject` / `CreateInstance`) yields a null
        Solution forever.

    WHY IT NEVER TOUCHES AN IDE IT DID NOT LAUNCH
    ---------------------------------------------
    A developer running this very likely has their own XAE Shell open, with unsaved work. An earlier
    automation obtained its DTE from `Marshal::GetActiveObject`, which resolves through the ROT's
    *CLSID* moniker (no PID), bound to whichever IDE registered first -- and then called `Quit()` on
    it. It closed a user's open shell. That is a real incident, not a hypothesis.

    This script therefore has THREE independent ownership gates, and refuses to run if any of them
    cannot be satisfied:
      1. It launches its OWN TcXaeShell.exe and only ever attaches by that PID, through the
         pid-suffixed ROT moniker (`!TcXaeShell.DTE.17.0:<pid>`). `GetActiveObject`,
         `New-Object -ComObject <ProgId>` and every other "any running instance" route are ABSENT BY
         DESIGN. Note this is stricter than generate-library-signatures.ps1, which keeps a
         GetActiveObject fallback for the case where ours is provably the only instance -- that
         fallback is deliberately NOT copied here.
      2. `Quit()` is gated on `Test-OwnDte` at the moment it is called, in the finally block: the
         process we launched must still be alive, and if its main window resolves it must resolve to
         that same PID. Quit is irreversible, so it is conditioned rather than assumed.

    A third gate was tried and REMOVED: asking the OS who owns `DTE.MainWindow.HWnd` and refusing to
    proceed unless it answered. A freshly launched shell has not drawn its window yet, so the probe
    returns nothing and the run aborted for a cosmetic reason -- stranding the very IDE it started.
    Ownership is already settled by (1): the ROT lookup is scoped to our PID, so the DTE cannot belong
    to anyone else. generate-library-signatures.ps1, which creates TwinCAT projects successfully, uses
    exactly that and no more.

    It also refuses to overwrite: `<OutputRoot>\<SolutionName>` must be absent or empty unless -Force
    is passed, because with the default -OutputRoot that path is a solution directory at the repo
    root -- name an existing one (`TcSample`, or a `TcSample_N` sandbox) and a silent clobber would
    destroy committed work.

.PARAMETER OutputRoot
    Directory the solution folder is created in. Defaults to the REPO ROOT -- the parent of this
    script's own directory, resolved relative to this script so it is correct whatever the working
    directory is. Solutions in this repo live as directories directly at the root (`TcSample\`), so
    the default drops a new skeleton in beside them, at `<repo>\<SolutionName>\`.

.PARAMETER SolutionName
    Name of the solution AND of its folder: everything lands in `<OutputRoot>\<SolutionName>`.

.PARAMETER PlcProjectName
    Name of the PLC project created under the system project. This repo names it `<Solution>_PLC`
    (TcSample / TcSample_PLC), and the default follows that -- build-sample-project.js's sandbox
    cloner renames the PLC project by substring from the solution name, so the two staying in step
    is what keeps a clone coming out consistent.

.PARAMETER TsProjTemplate
    The TwinCAT XAE system-project template. A full path is correct here (unlike -PlcTemplate).

.PARAMETER PlcTemplate
    File NAME of the PLC project template. TwinCAT resolves it from its own template directory --
    passing a full path makes it derive the project name from the file's basename and then fail to
    insert it.

.PARAMETER ShellExe
    The TcXaeShell.exe to drive. A machine can have BOTH the 64-bit shell (Program Files, DTE ProgID
    TcXaeShell.DTE.17.0) and the 32-bit one (Program Files (x86), TcXaeShell.DTE.15.0) installed.
    Defaults to the 64-bit shell, falling back to the 32-bit one only if the 64-bit is not installed
    and the caller did not name a shell explicitly. An explicitly named shell that does not exist is a
    hard error -- never a silent fallback.

.PARAMETER ProgId
    The DTE ProgID of that shell, used to cross-check the ROT moniker we attached to. Defaults to the
    ProgID paired with the resolved -ShellExe.

.PARAMETER Force
    Proceed even though `<OutputRoot>\<SolutionName>` already exists and is non-empty. -Force NEVER
    DELETES ANYTHING: it creates into the existing directory. (Deleting would take the committed
    project in that directory with it.)

.EXAMPLE
    # Defaults: creates <repo>\TcSkeleton\, a sibling of the committed TcSample\.
    powershell.exe -NoProfile -STA -File scripts\build-sample-solution.ps1

.EXAMPLE
    powershell.exe -NoProfile -STA -File scripts\build-sample-solution.ps1 `
        -OutputRoot C:\scratch -SolutionName TcScratch -PlcProjectName TcScratch_PLC
#>

param(
    [string] $OutputRoot = '',

    [string] $SolutionName = 'TcSkeleton',

    [string] $PlcProjectName = 'TcSkeleton_PLC',

    [string] $TsProjTemplate = 'C:\Program Files (x86)\Beckhoff\TwinCAT\3.1\Components\Base\PrjTemplate\TwinCAT Project.tsproj',

    [string] $PlcTemplate = 'Standard PLC Template.plcproj',

    [string] $ShellExe = '',

    [string] $ProgId = '',

    [switch] $Force
)

$ErrorActionPreference = 'Continue'

# The two shells, newest first, each paired with the DTE ProgID it registers in the ROT. Pairing them
# here is deliberate: generate-library-signatures.ps1 keeps two parallel arrays, and an exe/ProgID
# mismatch there is exactly the failure mode its header warns about.
$SHELLS = @(
    @{ Exe = 'C:\Program Files\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe';       ProgId = 'TcXaeShell.DTE.17.0' },
    @{ Exe = 'C:\Program Files (x86)\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe'; ProgId = 'TcXaeShell.DTE.15.0' }
)

# ------------------------------------------------------------------------------------------------
# Preflight: apartment state and PowerShell edition
# ------------------------------------------------------------------------------------------------
#
# generate-library-signatures.ps1 documents the -STA requirement in its header and trusts the caller
# (the extension) to pass it. This script is run by hand, so it checks instead of trusting: an MTA
# thread marshals every DTE call through a proxy and the IDE's initialisation never completes.

if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
    Write-Host "FAILURE: this script must run in a single-threaded apartment."
    Write-Host "         Re-run it as:  powershell.exe -NoProfile -STA -File $PSCommandPath"
    exit 1
}

if ($PSVersionTable.PSEdition -eq 'Core') {
    Write-Host "FAILURE: run this under Windows PowerShell 5.1 (powershell.exe), not PowerShell 7+ (pwsh)."
    Write-Host "         PowerShell 7 defaults to MTA and its COM interop does not drive the DTE reliably."
    exit 1
}

# ------------------------------------------------------------------------------------------------
# COM plumbing -- COPIED VERBATIM from scripts/generate-library-signatures.ps1. Keep in sync.
# ------------------------------------------------------------------------------------------------

Add-Type -AssemblyName System.Windows.Forms

# The `-as [type]` guards are the only change to the copied blocks: they let this script and
# generate-library-signatures.ps1 coexist in one PowerShell session without Add-Type failing on a
# duplicate type name. The C# bodies themselves are unmodified.
if (-not ('TcMessageFilter' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport(), Guid("00000016-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOleMessageFilter
{
    [PreserveSig] int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);
    [PreserveSig] int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);
    [PreserveSig] int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
}

// Without this filter a busy IDE simply rejects our COM calls (RPC_E_CALL_REJECTED).
public class TcMessageFilter : IOleMessageFilter
{
    public static void Register() { IOleMessageFilter old = null; CoRegisterMessageFilter(new TcMessageFilter(), out old); }
    public static void Revoke()   { IOleMessageFilter old = null; CoRegisterMessageFilter(null, out old); }

    // SERVERCALL_ISHANDLED -- accept incoming calls.
    int IOleMessageFilter.HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo)
    { return 0; }

    // dwRejectType 2 == SERVERCALL_RETRYLATER: the IDE is merely busy, so retry in 200 ms. Anything
    // else is a genuine refusal and must be cancelled (-1). Inverting this is an infinite hang.
    int IOleMessageFilter.RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType)
    { if (dwRejectType == 2) { return 200; } return -1; }

    // PENDINGMSG_WAITDEFPROCESS -- keep dispatching while we wait.
    int IOleMessageFilter.MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType)
    { return 2; }

    [DllImport("Ole32.dll")]
    private static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);
}
'@
}

<#
.SYNOPSIS
    Sleeps while pumping the Windows message queue.
.DESCRIPTION
    COPIED from generate-library-signatures.ps1. Load-bearing: a plain Start-Sleep starves the STA
    message loop, and the DTE then never completes its initialisation -- $dte.Solution stays null
    indefinitely. Every wait in this script goes through here.
#>
function Wait-Pumped {
    param([int] $Milliseconds)
    $end = (Get-Date).AddMilliseconds($Milliseconds)
    while ((Get-Date) -lt $end) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 50
    }
}

# Running Object Table lookup, BY PID. COPIED VERBATIM from generate-library-signatures.ps1.
#
# THIS IS A SAFETY MECHANISM, NOT AN OPTIMISATION. Do not replace it with GetActiveObject().
#
# Marshal::GetActiveObject($progId) resolves through the ROT's *CLSID* moniker, which carries no PID:
# a launching shell registers BOTH `!TcXaeShell.DTE.17.0:<pid>` and `!{47F09213-...}` (measured), and
# GetActiveObject binds to the latter -- i.e. to whichever IDE registered first. If the user already
# had an XAE Shell open, that is THEIR IDE. This script then ran Solution.Create against it and, in
# its finally block, called $dte.Quit(). It closed a user's open shell window. That is a real
# incident, not a hypothesis.
#
# The pid-suffixed moniker is the one that identifies a specific process, and it is real: launching
# TcXaeShell 17.0 and watching the ROT produced `!TcXaeShell.DTE.17.0:24304` four seconds in. We match
# on the ":<pid>" suffix rather than the whole moniker because a VS-shell-derived IDE may register
# under a `VisualStudio.DTE.*` name instead of its own ProgID -- the PID is the part we trust.
#
# The enumeration lives in C# because it has to: PowerShell's [ref] marshalling hands back a
# late-bound __ComObject for `out IRunningObjectTable`, and none of the interface methods are then
# callable ("does not contain a method named EnumRunning").
if (-not ('TcRot' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class TcRot
{
    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(uint reserved, out IRunningObjectTable prot);
    [DllImport("ole32.dll")]
    private static extern int CreateBindCtx(uint reserved, out IBindCtx ppbc);

    /// <summary>The DTE of exactly one process, or null. Never returns another instance's.</summary>
    public static object GetDteByPid(int processId, out string moniker)
    {
        moniker = null;
        IRunningObjectTable rot; IBindCtx ctx; IEnumMoniker en;
        if (GetRunningObjectTable(0, out rot) != 0 || rot == null) return null;
        if (CreateBindCtx(0, out ctx) != 0 || ctx == null) return null;
        rot.EnumRunning(out en);
        if (en == null) return null;
        en.Reset();

        string suffix = ":" + processId;
        var mk = new IMoniker[1];
        while (en.Next(1, mk, IntPtr.Zero) == 0)
        {
            string name;
            try { mk[0].GetDisplayName(ctx, null, out name); } catch { continue; }
            if (string.IsNullOrEmpty(name)) continue;
            if (!name.EndsWith(suffix, StringComparison.Ordinal)) continue;
            if (name.IndexOf("DTE", StringComparison.OrdinalIgnoreCase) < 0) continue;

            object obj;
            try { rot.GetObject(mk[0], out obj); } catch { continue; }
            if (obj != null) { moniker = name; return obj; }
        }
        return null;
    }
}
'@
}

# NOT copied -- new here. The second ownership gate: ask the OS which process owns the DTE's main
# window. GetDteByPid matched a moniker STRING; this is the kernel's own answer, and it is what makes
# "we are driving our own IDE" a verified fact rather than an inference.
if (-not ('TcWin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TcWin
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    /// <summary>The PID owning a window handle, or 0 if it cannot be determined.</summary>
    public static int ProcessIdOfWindow(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) { return 0; }
        int pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }
}
'@
}

<#
.SYNOPSIS
    Gets the DTE of the IDE process we launched, and of no other.
.DESCRIPTION
    COPIED from generate-library-signatures.ps1 (see the comment block above it).
.PARAMETER ProcessId
    The PID returned by Start-Process. Only this process's DTE is ever returned.
#>
function Get-DteByPid {
    param(
        [int] $ProcessId,
        [string] $ExpectedProgId = ''
    )

    $moniker = $null
    $dte = [TcRot]::GetDteByPid($ProcessId, [ref] $moniker)
    if (-not $dte) { return $null }

    Write-Host "  attached to PID $ProcessId via ROT moniker '$moniker'"

    # The moniker names the ProgID of the IDE we just attached to. If it is not the one we were told
    # to drive, we are about to drive the WRONG BITNESS' shell -- silently. Stop loudly instead.
    if ($ExpectedProgId -and $moniker -notlike "*$ExpectedProgId*") {
        throw ("attached to '$moniker' but the requested shell was '$ExpectedProgId'. Refusing to " +
               "continue: this is not the IDE we were asked to drive.")
    }
    return $dte
}

<#
.SYNOPSIS
    True when the DTE still provably belongs to the process we launched. Never throws.
.DESCRIPTION
    Quit() is irreversible, so the finally block re-verifies ownership
    instead of trusting that the check made at attach time still holds.
#>
function Test-OwnDte {
    param($Dte, [int] $ProcessId)

    if (-not $Dte -or -not $ProcessId) { return $false }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
    try {
        $handle = $Dte.MainWindow.HWnd
        # No window handle is not evidence of foreign ownership -- the DTE was obtained by a PID-scoped
        # ROT lookup, so it belongs to $ProcessId by construction, and Quit() on it can only ever close
        # that process. Returning $false here would strand the IDE we launched instead of closing it.
        if (-not $handle) { return $true }
        return ([TcWin]::ProcessIdOfWindow([IntPtr][int64] $handle) -eq $ProcessId)
    } catch {
        # Same reasoning: a probe failure is not proof the DTE is someone else's.
        return $true
    }
}

<#
.SYNOPSIS
    Every .sln / .tsproj / .plcproj under a directory, as a set of full paths.
.DESCRIPTION
    Used to snapshot the target directory before and after, so the inventory can say which artifacts
    this run actually WROTE rather than which ones merely exist -- the distinction matters under
    -Force, where the directory already holds committed fixtures.
#>
function Get-ProjectArtifacts {
    param([string] $Root)

    $found = @{}
    if (-not (Test-Path -LiteralPath $Root)) { return $found }
    Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @('.sln', '.tsproj', '.plcproj') } |
        ForEach-Object { $found[$_.FullName] = $true }
    return $found
}

# ------------------------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------------------------

# The repo ROOT: this script lives in <repo>\Scripts\, and solutions in this repo are directories
# directly at the root (TcSample\), so a generated skeleton belongs beside them rather than in a
# subdirectory of its own. Resolved from this script's own location so the default is correct
# regardless of the working directory. Kept out of the param() default because $PSScriptRoot is not
# reliably populated there when the script is dot-sourced rather than run with -File.
# Walk UP to the git root rather than assuming the script sits one level below it. This file has
# already been moved once (Scripts\ -> Scripts\Create sample project\), and a fixed depth silently
# resolves to the wrong directory when that happens - here it would create skeletons inside Scripts\.
if (-not $OutputRoot) {
    $dir = $PSScriptRoot
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { break }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { $dir = $null; break }
        $dir = $parent
    }
    $OutputRoot = if ($dir) { $dir } else { Split-Path -Parent $PSScriptRoot }
}

if (-not (Test-Path -LiteralPath $OutputRoot)) {
    New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
}
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path

# Everything lands here: <OutputRoot>\<SolutionName>\{ .sln, .tsproj, <PlcProjectName>\*.plcproj }
$solutionDir = Join-Path $OutputRoot $SolutionName
$slnPath = Join-Path $solutionDir "$SolutionName.sln"

# Refuse to overwrite. With the default -OutputRoot this is a directory at the repo root -- a sibling
# of the committed TcSample\ -- so naming an existing solution would put a silent clobber on top of
# real work. -Force proceeds INTO the directory; it never deletes.
if (Test-Path -LiteralPath $solutionDir) {
    $existing = @(Get-ChildItem -LiteralPath $solutionDir -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0 -and -not $Force) {
        Write-Host "FAILURE: '$solutionDir' already exists and is not empty ($($existing.Count) entries)."
        Write-Host "         That directory already holds a project -- this script will not write into it"
        Write-Host "         silently. Either pick a -SolutionName that is free, point -OutputRoot at a"
        Write-Host "         scratch directory and move the result in by hand, or re-run with -Force"
        Write-Host "         (which creates into the existing directory and deletes nothing)."
        exit 1
    }
    if ($existing.Count -gt 0) {
        Write-Host "NOTE: -Force given: creating into the existing, non-empty '$solutionDir'. Nothing is deleted."
    }
}

# Which shell to drive. An explicitly named one must exist (never a silent fallback to the other
# bitness); otherwise take the first installed pair, 64-bit first.
#
# The local MUST NOT be called $shellExe. PowerShell variable names are case-INSENSITIVE, so
# `$shellExe` and the `$ShellExe` parameter are one and the same -- assigning to the lower-case
# spelling erases the caller's choice and silently launches the wrong bitness. That bug shipped once
# already (see generate-library-signatures.ps1).
$resolvedShellExe = $null
$resolvedProgId = $ProgId

if ($PSBoundParameters.ContainsKey('ShellExe') -and $ShellExe) {
    if (-not (Test-Path -LiteralPath $ShellExe)) {
        Write-Host "FAILURE: the requested TcXaeShell.exe does not exist: $ShellExe"
        exit 1
    }
    $resolvedShellExe = (Resolve-Path -LiteralPath $ShellExe).Path
    if (-not $resolvedProgId) {
        $match = $SHELLS | Where-Object { $_.Exe -eq $resolvedShellExe } | Select-Object -First 1
        if ($match) { $resolvedProgId = $match.ProgId }
    }
} else {
    foreach ($candidate in $SHELLS) {
        if (Test-Path -LiteralPath $candidate.Exe) {
            $resolvedShellExe = $candidate.Exe
            if (-not $resolvedProgId) { $resolvedProgId = $candidate.ProgId }
            break
        }
    }
}

if (-not $resolvedShellExe) {
    Write-Host "FAILURE: TcXaeShell.exe not found. A TwinCAT (XAE) installation is required."
    exit 1
}
if (-not (Test-Path -LiteralPath $TsProjTemplate)) {
    Write-Host "FAILURE: TwinCAT project template not found: $TsProjTemplate"
    exit 1
}
# -PlcTemplate is a bare FILE NAME by design (TwinCAT resolves it from its own template directory), so
# it cannot be existence-checked here. Catch the mistake of passing a path instead.
if ($PlcTemplate -match '[\\/]') {
    Write-Host "FAILURE: -PlcTemplate must be a bare file name, not a path: $PlcTemplate"
    Write-Host "         TwinCAT resolves it from its own template directory; a full path makes it name"
    Write-Host "         the project after the template's basename and then fail to insert it."
    exit 1
}

Write-Host "Output root  : $OutputRoot"
Write-Host "Solution dir : $solutionDir"
Write-Host "Solution     : $SolutionName"
Write-Host "PLC project  : $PlcProjectName"
Write-Host "Shell        : $resolvedShellExe"
Write-Host "ProgID       : $(if ($resolvedProgId) { $resolvedProgId } else { '(none -- ROT ProgID cross-check disabled)' })"

$before = Get-ProjectArtifacts -Root $solutionDir

[TcMessageFilter]::Register()

$shellProc = $null
$launchedId = 0
$dte = $null
$exitCode = 1

try {
    # Which instances of this exe were already running BEFORE we launched ours. They are the user's,
    # they may hold unsaved work, and nothing this script does may ever reach them.
    $preExisting = @(
        Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($resolvedShellExe)) -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $resolvedShellExe } |
            Select-Object -ExpandProperty Id
    )
    if ($preExisting.Count -gt 0) {
        Write-Host "NOTE: $($preExisting.Count) instance(s) of this shell are already open (PID $($preExisting -join ', ')). They will not be touched."
    }

    Write-Host "Starting TwinCAT XAE shell (this can take a minute)..."
    $shellProc = Start-Process -FilePath $resolvedShellExe -PassThru
    # NB: never name this $pid -- that is a read-only automatic variable.
    $launchedId = $shellProc.Id
    Write-Host "  shell PID $launchedId"

    # Paranoia, cheap: the PID we are about to drive must not be one that was already running.
    if ($preExisting -contains $launchedId) {
        throw "the PID we launched ($launchedId) is one that was already running. Refusing to continue."
    }

    # Attach to the IDE we just launched, BY PID, through the Running Object Table. There is NO
    # fallback: generate-library-signatures.ps1 permits GetActiveObject when ours is provably the only
    # instance, but this script creates a solution and quits the IDE, so it holds the stricter line --
    # if we cannot attach to our own process, we stop.
    Write-Host "Attaching to the automation interface (PID $launchedId)..."
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline -and $null -eq $dte) {
        if (-not (Get-Process -Id $launchedId -ErrorAction SilentlyContinue)) {
            throw "the shell we launched (PID $launchedId) exited before it registered its automation interface"
        }
        $dte = Get-DteByPid -ProcessId $launchedId -ExpectedProgId $resolvedProgId
        if ($null -eq $dte) { Wait-Pumped -Milliseconds 500 }
    }
    if ($null -eq $dte) {
        throw ("could not attach to the shell we launched (PID $launchedId) within 180 s. Attaching to " +
               "'any' running instance is not an option here -- it would drive, and then close, an IDE " +
               "that may be yours.")
    }

    # No further ownership gate here, deliberately. Ownership is already established the way
    # generate-library-signatures.ps1 (which creates TwinCAT projects successfully) establishes it:
    # a pre-launch census of this exe's PIDs, then a ROT lookup scoped to the PID we launched, with
    # the ProgID cross-checked. The DTE therefore belongs to $launchedId by construction.
    #
    # An extra "ask the OS who owns the main window" check was tried here and had to be removed: a
    # freshly launched shell has not drawn its window yet, so the probe returns nothing, and the run
    # aborted for a cosmetic reason -- leaving the IDE it launched running.

    # Pumping here is what lets the DTE finish initialising; without it Solution stays null forever.
    $solution = $null
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        try { $solution = $dte.Solution } catch { $solution = $null }
        if ($null -ne $solution) { break }
        Wait-Pumped -Milliseconds 500
    }
    if ($null -eq $solution) { throw "the IDE's Solution object never became available" }

    Write-Host "Creating the solution..."
    $solution.Create($OutputRoot, $SolutionName)
    Wait-Pumped -Milliseconds 1500

    Write-Host "Inserting the TwinCAT system project..."
    $null = $solution.AddFromTemplate($TsProjTemplate, $solutionDir, $SolutionName, $false)
    Wait-Pumped -Milliseconds 2000

    # The XAE project's .Object is the system manager. Find the project that actually has a PLC node
    # -- identity by capability, not by index, because the solution may hold more than one project.
    $sysManager = $null
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and $null -eq $sysManager) {
        try {
            foreach ($project in $solution.Projects) {
                try {
                    $candidate = $project.Object
                    $null = $candidate.LookupTreeItem('TIPC')
                    $sysManager = $candidate
                    break
                } catch { }
            }
        } catch { }
        if ($null -eq $sysManager) { Wait-Pumped -Milliseconds 500 }
    }
    if ($null -eq $sysManager) { throw "the solution produced no usable TwinCAT system manager" }

    Write-Host "Adding the PLC project..."
    # The template must be the bare FILE NAME: TwinCAT resolves it from its own template directory,
    # and a full path makes it name the project after the template's basename and then fail to insert
    # it. (Validated above.)
    #
    # NOTE: creation needs no LookupTreeItem on the PLC *project* node, so the localized
    # "<name> Project" / "<name> Projekt" discovery that generate-library-signatures.ps1 needs
    # (:517-528) is deliberately NOT reproduced here -- it would be a lookup we never use.
    $null = $sysManager.LookupTreeItem('TIPC').CreateChild($PlcProjectName, 0, '', $PlcTemplate)
    Wait-Pumped -Milliseconds 3000

    # Persist. This is the entire point of the script -- everything above lives only in the IDE's
    # memory until now.
    #
    # ORDER IS LOAD-BEARING: the solution must be given a path BEFORE File.SaveAll runs. A SaveAll on
    # a never-saved solution raises a MODAL "Save As" dialog, and a modal dialog in an IDE we are
    # driving headlessly is an unrecoverable hang -- the script would sit in Wait-Pumped until its
    # deadline and then quit the shell out from under the dialog.
    Write-Host "Saving to disk..."
    # AddFromTemplate normally creates the solution folder, but SaveAs into a directory that does not
    # exist throws -- and it would throw AFTER the PLC project was created, losing the whole run.
    if (-not (Test-Path -LiteralPath $solutionDir)) {
        New-Item -ItemType Directory -Path $solutionDir -Force | Out-Null
    }
    $solution.SaveAs($slnPath)
    Wait-Pumped -Milliseconds 1500

    # The TwinCAT system project persists through the DTE Project object rather than an ITcSysManager
    # call: the sysmanager save APIs differ across TwinCAT builds, Project.Save() does not.
    try {
        foreach ($project in $solution.Projects) {
            try { $project.Save() } catch { }
        }
    } catch { }
    Wait-Pumped -Milliseconds 1000

    try { $dte.ExecuteCommand('File.SaveAll') } catch { }
    Wait-Pumped -Milliseconds 3000

    # Verify on disk. The exact directory each artifact lands in is TwinCAT's decision (AddFromTemplate
    # and CreateChild both interpret their destination), so search rather than assert fixed paths -- a
    # hard-coded guess here would fail loudly for the wrong reason. The .sln alone is pinned, because
    # SaveAs put it exactly where we asked.
    $slnFound = Test-Path -LiteralPath $slnPath
    if (-not $slnFound) {
        # SaveAs may have honoured the IDE's own layout instead; accept OUR solution wherever under the
        # output root it landed. Matched by NAME, not '*.sln': the default -OutputRoot is the repo root,
        # which already holds TcSample\TcSample.sln (plus any TcSample_N sandbox), and a bare '*.sln'
        # sweep would "find" one of those and report a solution this run never wrote as its output.
        $strays = @(Get-ChildItem -LiteralPath $OutputRoot -Recurse -File -Filter "$SolutionName.sln" -ErrorAction SilentlyContinue)
        if ($strays.Count -gt 0) { $slnPath = $strays[0].FullName; $slnFound = $true }
    }
    if (-not $slnFound) { throw "no $SolutionName.sln was written under $OutputRoot" }

    $tsProjFiles = @(Get-ChildItem -LiteralPath $solutionDir -Recurse -File -Filter '*.tsproj' -ErrorAction SilentlyContinue)
    if ($tsProjFiles.Count -eq 0) { throw "no .tsproj was written under $solutionDir" }

    $plcProjFiles = @(Get-ChildItem -LiteralPath $solutionDir -Recurse -File -Filter '*.plcproj' -ErrorAction SilentlyContinue)
    $plcProj = $plcProjFiles | Where-Object { $_.Directory.Name -eq $PlcProjectName } | Select-Object -First 1
    if (-not $plcProj) {
        throw ("no '$PlcProjectName\$PlcProjectName.plcproj' was written under $solutionDir " +
               "($($plcProjFiles.Count) .plcproj file(s) found elsewhere)")
    }

    # Inventory. Under -Force the directory already held fixtures, so mark what this run added.
    $after = Get-ProjectArtifacts -Root $solutionDir
    Write-Host ""
    Write-Host "Wrote:"
    Write-Host "  solution     : $slnPath"
    foreach ($file in $tsProjFiles)  { Write-Host "  system proj  : $($file.FullName)" }
    Write-Host "  PLC project  : $($plcProj.FullName)"
    $added = @($after.Keys | Where-Object { -not $before.ContainsKey($_) } | Sort-Object)
    Write-Host ""
    Write-Host "New project artifacts under '$solutionDir' ($($added.Count)):"
    foreach ($path in $added) { Write-Host "  + $path" }
    $kept = @($after.Keys | Where-Object { $before.ContainsKey($_) })
    if ($kept.Count -gt 0) { Write-Host "  ($($kept.Count) pre-existing artifact(s) left untouched)" }

    Write-Host ""
    Write-Host "SUCCESS: TwinCAT solution skeleton created."
    $exitCode = 0
}
catch {
    Write-Host "FAILURE: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    # Close the solution and shut the IDE down -- but ONLY ever the IDE we launched, and only if that
    # is still provably true at this instant. Quit() is irreversible: an earlier automation quit a
    # user's open shell, so this is gated on a re-verified fact, not on our believing the check we
    # made minutes ago still holds. See Test-OwnDte.
    #
    # Close($false) is safe here because persistence was already verified on disk above; asking the
    # IDE to save again on the way out risks the modal dialog we were careful to avoid.
    if (Test-OwnDte -Dte $dte -ProcessId $launchedId) {
        try { $dte.Solution.Close($false) } catch { }
        try { $dte.Quit() } catch { }
        Wait-Pumped -Milliseconds 2000
    } elseif ($dte) {
        Write-Host "NOTE: not quitting the IDE -- could not re-confirm that PID $launchedId is the process we launched."
    }

    # ...then make sure the shell is really gone -- but ONLY the process we launched. Killing by name
    # would take down an IDE the user had open with unsaved work.
    if ($shellProc) {
        try {
            if (Get-Process -Id $shellProc.Id -ErrorAction SilentlyContinue) {
                Stop-Process -Id $shellProc.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    try { [TcMessageFilter]::Revoke() } catch { }
}

exit $exitCode
