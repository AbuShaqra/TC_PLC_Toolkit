<#
.SYNOPSIS
    Generates library-signatures.xml for a TwinCAT workspace by driving TwinCAT's Automation Interface.

.DESCRIPTION
    The extension is fully offline and cannot read TwinCAT's library metadata itself: the `.compiled-library`
    archives give bare symbol NAMES only, and the project's `.tmc` gives structure only for the ~350 types the
    project already uses. Function signatures, function-block I/O for unused FBs, and global constants exist in
    neither. TwinCAT itself can produce all of that — `ITcPlcLibraryManager2.ProduceAllLibrarySignatures()`
    returns a per-library XML dump — but only on a machine that HAS TwinCAT.

    So this script is the (user-invoked) bridge: it runs the IDE once, dumps the signatures of every library the
    workspace's `.plcproj` references, and writes `<workspace>\library-signatures.xml`. The extension then indexes
    that file offline (src/lsp/libsymbols.js `indexLibrarySignatures`). Nothing else in the extension touches
    TwinCAT, and the generated file is just data.

    HOW IT DRIVES THE IDE (every step here was established empirically -- do not "simplify" them away):
      * Windows PowerShell 5.1 in **-STA** mode. COM interop into the DTE needs a single-threaded apartment.
      * An **IOleMessageFilter** must be registered, or a busy IDE rejects our calls outright. RetryRejectedCall
        must return a retry delay for SERVERCALL_RETRYLATER (dwRejectType == 2) and -1 (cancel) otherwise --
        inverting that is a hang.
      * Every wait loop must pump the message queue (`Application::DoEvents`). WITHOUT a pump the DTE never
        finishes initialising and `$dte.Solution` stays null forever.
      * The shell is launched as a NORMAL process and then attached through the Running Object Table. A COM
        `-Embedding` activation (`New-Object -ComObject` / `CreateInstance`) yields a null Solution forever.
      * The PLC project node is NOT enumerable as a child of the PLC node (only "<name> Instance" is), so it is
        reached by an explicit `LookupTreeItem` path. That path is LOCALIZED -- on a German IDE it is
        "LibDump Projekt" -- while its children are not ("References" stays English). Both are therefore
        discovered, never assumed.
      * `GetLibraryIecDeclaration` is deliberately NOT used: it is E_NOINTERFACE on this TwinCAT build.

.PARAMETER WorkspaceFolder
    The workspace root. Its `.plcproj` files are read for library references, and the output is written here.

.PARAMETER TsProjTemplate
    The TwinCAT XAE project template used to spin up the throwaway solution.

.PARAMETER PlcTemplate
    File NAME of the PLC project template. TwinCAT resolves it from its own template directory -- passing a full
    path makes it derive the project name from the file's basename and then fail to insert it.

.PARAMETER OutputFile
    Where to write the dump. Defaults to <WorkspaceFolder>\library-signatures.xml.

.PARAMETER ShellExe
    The TcXaeShell.exe to drive. A machine can have BOTH the 64-bit shell (Program Files, DTE ProgID
    TcXaeShell.DTE.17.0) and the 32-bit one (Program Files (x86), TcXaeShell.DTE.15.0) installed, and
    they are not interchangeable: the same library can produce DIFFERENT signatures depending on which
    shell the throwaway project was created in -- visualisation libraries especially. The extension
    therefore asks the user and passes the answer in. Left empty, the script falls back to its own
    first-hit discovery so it still works when run by hand.

.PARAMETER ProgId
    The DTE ProgID of that shell, used to attach through the Running Object Table. When given it is the
    ONLY ProgID tried: falling back to the other one could attach to the other bitness' IDE if the user
    happens to have it open, and silently produce exactly the signatures they were trying to avoid.

.EXAMPLE
    powershell.exe -NoProfile -STA -File generate-library-signatures.ps1 C:\path\to\workspace

.EXAMPLE
    powershell.exe -NoProfile -STA -File generate-library-signatures.ps1 C:\path\to\workspace `
        -ShellExe 'C:\Program Files\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe' `
        -ProgId 'TcXaeShell.DTE.17.0'
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $WorkspaceFolder,

    [string] $TsProjTemplate = 'C:\Program Files (x86)\Beckhoff\TwinCAT\3.1\Components\Base\PrjTemplate\TwinCAT Project.tsproj',

    [string] $PlcTemplate = 'Standard PLC Template.plcproj',

    [string] $OutputFile = '',

    [string] $ShellExe = '',

    [string] $ProgId = '',

    # Diagnostic: list every library version this shell's repository actually holds, then exit without
    # dumping. The two shells do NOT carry the same versions, and a version the .plcproj pins can be
    # absent from one of them -- which is how a library gets silently dropped.
    [switch] $ListInstalled
)

$ErrorActionPreference = 'Continue'

# The throwaway PLC project's name. Also the leaf of the localized LookupTreeItem path below.
$PLC_NAME = 'LibDump'

# Where TcXaeShell may live, newest first. Only a FALLBACK for a hand-run without -ShellExe: the shells
# are not interchangeable (see .PARAMETER ShellExe), so first-hit-wins is a last resort, not a policy.
$SHELL_PATHS = @(
    'C:\Program Files\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe',
    'C:\Program Files (x86)\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe'
)

# The ProgIDs of those two shells, in the same order. Fallback for a hand-run without -ProgId.
$DTE_PROGIDS = @('TcXaeShell.DTE.17.0', 'TcXaeShell.DTE.15.0')

# Directories that never hold the project's own .plcproj (mirrors src/lsp/libraries.js SKIP_DIRS).
$SKIP_DIRS = @('.git', 'node_modules', '.vscode', '_libraries', 'st_files', '_compileinfo')

if (-not $OutputFile) { $OutputFile = Join-Path $WorkspaceFolder 'library-signatures.xml' }

# ------------------------------------------------------------------------------------------------
# COM plumbing
# ------------------------------------------------------------------------------------------------

Add-Type -AssemblyName System.Windows.Forms

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

<#
.SYNOPSIS
    Sleeps while pumping the Windows message queue.
.DESCRIPTION
    Load-bearing: a plain Start-Sleep starves the STA message loop, and the DTE then never completes its
    initialisation -- $dte.Solution stays null indefinitely. Every wait in this script goes through here.
#>
function Wait-Pumped {
    param([int] $Milliseconds)
    $end = (Get-Date).AddMilliseconds($Milliseconds)
    while ((Get-Date) -lt $end) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 50
    }
}

# Running Object Table lookup, BY PID.
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

<#
.SYNOPSIS
    Gets the DTE of the IDE process we launched, and of no other. See the comment block above.
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

    # The moniker names the ProgID of the IDE we just attached to. If it is not the one we were told to
    # drive, we are about to dump the WRONG BITNESS' signatures -- silently, and they look perfectly
    # valid. That is exactly what a `$shellExe`/`$ShellExe` name collision did: it launched the 64-bit
    # shell when the user picked the 32-bit one. Stop loudly instead.
    if ($ExpectedProgId -and $moniker -notlike "*$ExpectedProgId*") {
        throw ("attached to '$moniker' but the requested shell was '$ExpectedProgId'. Refusing to " +
               "continue: the signatures produced would be the other bitness'.")
    }
    return $dte
}

# ------------------------------------------------------------------------------------------------
# .plcproj parsing -- mirrors src/lsp/libraries.js + libsymbols.js (regex, never a DOM)
# ------------------------------------------------------------------------------------------------

<#
.SYNOPSIS
    Splits a <DefaultResolution> -- "Recipe Management, * (System)" -- into title / version / company.
#>
function Split-Resolution {
    param([string] $Text)
    $m = [regex]::Match($Text, '^\s*([^,]+?)\s*(?:,\s*([^()]*?)\s*)?(?:\(\s*([^)]*?)\s*\)\s*)?$')
    if (-not $m.Success) { return @{ title = $Text.Trim(); version = ''; company = '' } }
    return @{
        title   = $m.Groups[1].Value.Trim()
        version = $m.Groups[2].Value.Trim()
        company = $m.Groups[3].Value.Trim()
    }
}

<#
.SYNOPSIS
    Splits a pinned reference's Include -- "Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH" -- into its
    three fields. A placeholder's Include has no commas, so it yields the title alone, which is correct:
    its version/company then come from <DefaultResolution>.
#>
function Split-Include {
    param([string] $Include)
    $parts = $Include -split ','
    $company = ''
    if ($parts.Count -gt 2) { $company = ($parts[2..($parts.Count - 1)] -join ',').Trim() }
    return @{
        title   = if ($parts.Count -gt 0) { $parts[0].Trim() } else { '' }
        version = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
        company = $company
    }
}

<#
.SYNOPSIS
    The libraries a workspace's .plcproj files reference, as {title, version, company} -- exactly the
    triple ITcPlcLibraryManager.AddLibrary() wants.
.DESCRIPTION
    <DefaultResolution> is the vendor's own naming and therefore wins; the Include attribute is the
    fallback (a pinned <LibraryReference> has no DefaultResolution at all). De-duplicated on the triple.
#>
function Get-ReferencedLibraries {
    param([string] $Root)

    $projFiles = @()
    Get-ChildItem -Path $Root -Recurse -Filter '*.plcproj' -File -ErrorAction SilentlyContinue | ForEach-Object {
        $skip = $false
        foreach ($part in ($_.FullName -split '[\\/]')) {
            if ($SKIP_DIRS -contains $part.ToLower()) { $skip = $true; break }
        }
        if (-not $skip) { $projFiles += $_.FullName }
    }

    $seen = @{}
    $libs = @()
    foreach ($file in $projFiles) {
        $xml = Get-Content -Path $file -Raw -ErrorAction SilentlyContinue
        if (-not $xml) { continue }

        $blockRe = [regex]'(?s)<(PlaceholderReference|LibraryReference)\b([^>]*)>(.*?)</\1>'
        foreach ($m in $blockRe.Matches($xml)) {
            $attrs = $m.Groups[2].Value
            $body = $m.Groups[3].Value

            $incM = [regex]::Match($attrs, 'Include\s*=\s*"([^"]*)"')
            $include = if ($incM.Success) { $incM.Groups[1].Value } else { '' }
            $resM = [regex]::Match($body, '<DefaultResolution>([^<]+)</DefaultResolution>')

            $fromInclude = Split-Include -Include $include
            $resolved = if ($resM.Success) { Split-Resolution -Text $resM.Groups[1].Value } else { @{ title = ''; version = ''; company = '' } }

            $title = if ($resolved.title) { $resolved.title } else { $fromInclude.title }
            $version = if ($resolved.version) { $resolved.version } else { $fromInclude.version }
            $company = if ($resolved.company) { $resolved.company } else { $fromInclude.company }
            if (-not $title) { continue }
            # AddLibrary only accepts a dotted numeric version or the '*' wildcard. The .plcproj also
            # writes symbolic versions verbatim -- "newest", and sometimes nothing at all -- and feeding
            # those through raises "TcLibVersion invalid string format!" and silently loses the library
            # (Tc2_ControllerToolbox is exactly this case in the sample). Anything that is not a version
            # number means "resolve it for me", which is precisely what '*' asks for.
            if ($version -ne '*' -and $version -notmatch '^\d+(\.\d+)*$') { $version = '*' }

            $key = "$title|$version|$company".ToLower()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $libs += [PSCustomObject]@{ Title = $title; Version = $version; Company = $company }
        }
    }
    return $libs
}

# ------------------------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $WorkspaceFolder)) {
    Write-Host "FAILURE: workspace folder not found: $WorkspaceFolder"
    exit 1
}
$WorkspaceFolder = (Resolve-Path -LiteralPath $WorkspaceFolder).Path

# The caller (the extension) picks the shell and names it explicitly, because which one produces the dump
# is a user decision. Only a hand-run without -ShellExe falls back to first-hit discovery.
#
# The local MUST NOT be called $shellExe. PowerShell variable names are case-INSENSITIVE, so `$shellExe`
# and the `$ShellExe` parameter are one and the same: `$shellExe = $null` erased the caller's choice,
# `if ($ShellExe)` was then false, and the fallback silently launched the *first* shell on disk -- the
# 64-bit one. Asking for the 32-bit shell ran the 64-bit shell and dumped its signatures. That shipped.
$resolvedShellExe = $null
if ($ShellExe) {
    if (-not (Test-Path -LiteralPath $ShellExe)) {
        Write-Host "FAILURE: the requested TcXaeShell.exe does not exist: $ShellExe"
        exit 1
    }
    $resolvedShellExe = (Resolve-Path -LiteralPath $ShellExe).Path
} else {
    foreach ($candidate in $SHELL_PATHS) {
        if (Test-Path -LiteralPath $candidate) { $resolvedShellExe = $candidate; break }
    }
}
if (-not $resolvedShellExe) {
    Write-Host "FAILURE: TcXaeShell.exe not found. A TwinCAT (XAE) installation is required to generate library signatures."
    exit 1
}
# Belt and braces against the class of bug above: whatever the caller asked for is what we run, or we stop.
if ($ShellExe -and $resolvedShellExe -ne (Resolve-Path -LiteralPath $ShellExe).Path) {
    Write-Host "FAILURE: internal error -- asked for '$ShellExe' but resolved '$resolvedShellExe'."
    exit 1
}

# A given -ProgId is the ONLY one tried: attaching to the other bitness' IDE (which GetActiveObject would
# happily do if the user has it open) would dump the signatures of the shell the user did not choose.
$progIds = if ($ProgId) { @($ProgId) } else { $DTE_PROGIDS }

if (-not (Test-Path -LiteralPath $TsProjTemplate)) {
    Write-Host "FAILURE: TwinCAT project template not found: $TsProjTemplate"
    exit 1
}

Write-Host "Workspace : $WorkspaceFolder"
Write-Host "Shell     : $resolvedShellExe"
Write-Host "ProgID(s) : $($progIds -join ', ')"

$libraries = Get-ReferencedLibraries -Root $WorkspaceFolder
Write-Host "Found $($libraries.Count) referenced librar$(if ($libraries.Count -eq 1) { 'y' } else { 'ies' }) in the .plcproj file(s)."
if ($libraries.Count -eq 0) {
    Write-Host "FAILURE: no library references found -- is this a TwinCAT PLC workspace?"
    exit 1
}

[TcMessageFilter]::Register()

$tmpRoot = Join-Path $env:TEMP ("tcsig_" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

$shellProc = $null
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

    # Attach to the IDE we just launched, BY PID, through the Running Object Table.
    #
    # Never GetActiveObject() here while another instance may be running: it returns whichever IDE
    # registered first, and this script goes on to run Solution.Create against it and $dte.Quit() it.
    # That closed a user's open shell. See Get-DteByPid.
    #
    # (A COM -Embedding activation is also not an option: it returns a DTE whose Solution stays null
    # forever. Launching the exe normally and attaching is the only combination that works.)
    Write-Host "Attaching to the automation interface (PID $launchedId)..."
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline -and $null -eq $dte) {
        if (-not (Get-Process -Id $launchedId -ErrorAction SilentlyContinue)) {
            throw "the shell we launched (PID $launchedId) exited before it registered its automation interface"
        }
        $dte = Get-DteByPid -ProcessId $launchedId -ExpectedProgId $ProgId
        if ($null -eq $dte) { Wait-Pumped -Milliseconds 500 }
    }

    if ($null -eq $dte) {
        # The ROT lookup is the only safe path when someone else's IDE is open. GetActiveObject is a
        # legitimate fallback ONLY when ours is provably the sole instance -- then "any" *is* "ours".
        if ($preExisting.Count -eq 0) {
            Write-Host "  ROT lookup found nothing; ours is the only instance, so falling back to GetActiveObject."
            foreach ($candidateProgId in $progIds) {
                try {
                    $dte = [System.Runtime.InteropServices.Marshal]::GetActiveObject($candidateProgId)
                    if ($dte) { Write-Host "  attached via $candidateProgId"; break }
                } catch { }
            }
        } else {
            throw ("could not attach to the shell we launched (PID $launchedId) within 180 s. " +
                   "Other instances of this shell are open, so attaching to 'any' instance is not safe " +
                   "-- it would drive, and then close, one of yours. Close them and run this again.")
        }
    }
    if ($null -eq $dte) { throw "could not attach to the TcXaeShell automation interface within 180 s" }

    # Pumping here is what lets the DTE finish initialising; without it Solution stays null forever.
    $solution = $null
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        try { $solution = $dte.Solution } catch { $solution = $null }
        if ($null -ne $solution) { break }
        Wait-Pumped -Milliseconds 500
    }
    if ($null -eq $solution) { throw "the IDE's Solution object never became available" }

    Write-Host "Creating a temporary TwinCAT solution..."
    $solution.Create($tmpRoot, $PLC_NAME)
    Wait-Pumped -Milliseconds 1500
    $null = $solution.AddFromTemplate($TsProjTemplate, (Join-Path $tmpRoot $PLC_NAME), $PLC_NAME, $false)
    Wait-Pumped -Milliseconds 2000

    # The XAE project's .Object is the system manager. Find the project that actually has a PLC node.
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
    if ($null -eq $sysManager) { throw "the temporary solution produced no usable TwinCAT system manager" }

    Write-Host "Adding a PLC project..."
    # The template must be the bare FILE NAME: TwinCAT resolves it from its own template directory, and a
    # full path makes it name the project after the template's basename and then fail to insert it.
    $null = $sysManager.LookupTreeItem('TIPC').CreateChild($PLC_NAME, 0, '', $PlcTemplate)
    Wait-Pumped -Milliseconds 3000

    # The PLC *project* node is not enumerable as a child of the PLC node, so look it up by path. That
    # path is localized ("LibDump Projekt" on a German IDE), hence the candidate list.
    $projNode = $null
    $projPath = ''
    foreach ($prefix in @('TIPC', 'SPS')) {
        foreach ($suffix in @('Project', 'Projekt')) {
            $path = "$prefix^$PLC_NAME^$PLC_NAME $suffix"
            try {
                $projNode = $sysManager.LookupTreeItem($path)
                $projPath = $path
                break
            } catch { }
        }
        if ($projNode) { break }
    }
    if ($null -eq $projNode) { throw "could not locate the PLC project node (tried English and German spellings)" }
    Write-Host "  PLC project node: $projPath"

    # Its children ARE enumerable, so discover the References node rather than guessing its name (it stays
    # "References" even on a German IDE -- the localization is not uniform, so never assume either way).
    $refsName = ''
    for ($i = 1; $i -le $projNode.ChildCount; $i++) {
        $child = $projNode.Child($i)
        if ($child.Name -match 'Reference|Verweis') { $refsName = $child.Name; break }
    }
    if (-not $refsName) { throw "could not locate the References node under $projPath" }

    $refs = $sysManager.LookupTreeItem("$projPath^$refsName")
    Write-Host "  References node : $projPath^$refsName"

    if ($ListInstalled) {
        Write-Host "Scanning this shell's library repository..."
        $repo = $refs.ScanLibraries()
        Write-Host "  $($repo.Count) library versions installed:"
        foreach ($entry in $repo) {
            Write-Host ("    {0,-42} {1,-14} {2}" -f $entry.Name, $entry.Version, $entry.Distributor)
        }
        $exitCode = 0
        return
    }

    # What this shell's repository actually holds. The two shells do NOT carry the same versions, which
    # is why a .plcproj that builds fine can still have libraries the chosen shell cannot resolve.
    $installed = @{}
    try {
        foreach ($entry in $refs.ScanLibraries()) {
            $key = "$($entry.Name)".Trim().ToLowerInvariant()
            if (-not $installed.ContainsKey($key)) { $installed[$key] = New-Object System.Collections.ArrayList }
            [void]$installed[$key].Add("$($entry.Version)".Trim())
        }
        Write-Host "  ($($installed.Count) libraries in this shell's repository)"
    } catch {
        Write-Host "  (could not scan the library repository: $($_.Exception.Message))"
    }

    <#
    .SYNOPSIS
        The installed version of a library that best matches the one the .plcproj pins.
    .DESCRIPTION
        The pinned version is a resolution request, not an identity. `Recipe Management, 3.3.1.0` is
        perfectly well INSTALLED -- as 3.5.13.0, 3.5.13.2 and 4.5.0.0 -- and AddLibrary on the pinned
        version fails with "Managed Library ... not found!", so we used to drop the library and every
        symbol in it.

        Picking the *newest* is wrong too, and quietly so: 4.5.0.0 adds without error and then produces
        an EMPTY <TypeSignatures /> -- it does not load in the 15.0 shell at all. So prefer the highest
        version sharing the pinned version's MAJOR line (3.x for a pinned 3.3.1.0 -> 3.5.13.2), which is
        the one that sits alongside the rest of the 3.5.13.x visu stack. Newest is only a last resort.

        A version mismatch costs nothing here: we dump SIGNATURES into a throwaway project, we do not
        build the user's code. Skipping the library, by contrast, loses everything it declares.
    #>
    function Select-InstalledVersion {
        param([string] $Title, [string] $Wanted)

        $key = "$Title".Trim().ToLowerInvariant()
        if (-not $installed.ContainsKey($key)) { return $null }

        $versions = @($installed[$key] | Where-Object { $_ -match '^\d+(\.\d+)+$' } | Sort-Object { [version] $_ })
        if ($versions.Count -eq 0) { return $null }

        if ($Wanted -match '^\d+(\.\d+)+$') {
            if ($versions -contains $Wanted) { return $Wanted }
            $major = ([version] $Wanted).Major
            $sameMajor = @($versions | Where-Object { ([version] $_).Major -eq $major })
            if ($sameMajor.Count -gt 0) { return $sameMajor[-1] }
        }
        return $versions[-1]
    }

    Write-Host "Adding the workspace's referenced libraries..."
    $added = 0
    $resolved = 0
    $failed = 0
    foreach ($lib in $libraries) {
        try {
            $refs.AddLibrary($lib.Title, $lib.Version, $lib.Company)
            $added++
            Write-Host "  + $($lib.Title) $($lib.Version) ($($lib.Company))"
            continue
        } catch {
            $addError = $_.Exception.Message
        }

        $alt = Select-InstalledVersion -Title $lib.Title -Wanted $lib.Version
        if ($alt -and $alt -ne $lib.Version) {
            try {
                $refs.AddLibrary($lib.Title, $alt, $lib.Company)
                $added++
                $resolved++
                Write-Host "  ~ $($lib.Title) ($($lib.Company)): $($lib.Version) is not in this shell's repository -- used $alt"
                continue
            } catch {
                $addError = $_.Exception.Message
            }
        }

        # Genuinely not installed. A partial result, not a failure: everything else still dumps.
        $failed++
        Write-Host "  ! skipped $($lib.Title) $($lib.Version) ($($lib.Company)): $addError"
    }
    Wait-Pumped -Milliseconds 2000
    Write-Host "  $added added ($resolved re-versioned), $failed skipped."

    # Poll until the dump stops growing.
    #
    # AddLibrary() returns as soon as the reference is *added*; the library manager then loads and
    # resolves the libraries in the background. Ask too early and TwinCAT answers happily -- with
    # `<Library><LibraryName>Tc2_Utilities</LibraryName>...<TypeSignatures /></Library>`. An EMPTY
    # element, not an error. With a flat 2 s wait the 32-bit shell (the older, slower one) produced
    # 2530 signatures where the 64-bit shell produced 4889, and 44 libraries came back completely
    # empty. It was never a TwinCAT limitation, and never a parsing bug -- we were just asking before
    # it had finished thinking.
    #
    # So: call it repeatedly, keep the richest answer, and stop once it has not grown for three
    # consecutive polls. Bounded, and it costs nothing on a shell that is already ready.
    Write-Host "Producing library signatures (waiting for the library manager to finish loading)..."
    $xml = $null
    $bestCount = -1
    $stable = 0
    $deadline = (Get-Date).AddSeconds(240)
    while ((Get-Date) -lt $deadline) {
        $candidate = $refs.ProduceAllLibrarySignatures()
        $count = if ($candidate) { ([regex]::Matches($candidate, '<TypeSignature\b')).Count } else { 0 }

        if ($count -gt $bestCount) {
            Write-Host "  $count signatures..."
            $bestCount = $count
            $xml = $candidate
            $stable = 0
        } else {
            $stable++
        }
        if ($bestCount -gt 0 -and $stable -ge 3) { break }
        Wait-Pumped -Milliseconds 3000
    }
    if (-not $xml) { throw "ProduceAllLibrarySignatures() returned nothing" }
    Write-Host "  settled at $bestCount signatures."

    # An empty <TypeSignatures /> on a library we successfully added means it never finished loading.
    # Say so: a quietly half-filled dump is worse than a loud one, because it looks perfectly valid.
    $emptyLibs = ([regex]::Matches($xml, '<LibraryName>([^<]+)</LibraryName>(?:(?!</Library>).)*?<TypeSignatures\s*/>', 'Singleline') |
        ForEach-Object { $_.Groups[1].Value })
    if ($emptyLibs.Count -gt 0) {
        Write-Host "  NOTE: $($emptyLibs.Count) librar$(if ($emptyLibs.Count -eq 1) { 'y' } else { 'ies' }) produced no signatures: $($emptyLibs -join ', ')"
    }

    [System.IO.File]::WriteAllText($OutputFile, $xml, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Wrote $($xml.Length) characters to $OutputFile"
    Write-Host "SUCCESS: library signatures written ($added librar$(if ($added -eq 1) { 'y' } else { 'ies' }) added, $failed skipped)."
    $exitCode = 0
}
catch {
    Write-Host "FAILURE: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    # Close the throwaway solution and shut the IDE down cleanly -- but ONLY ever the IDE we launched.
    #
    # The guard is the whole point. $dte used to come from GetActiveObject, so on a machine with an XAE
    # Shell already open it was the *user's* IDE: this block then closed their solution and quit their
    # window. Get-DteByPid now makes $dte provably the process in $launchedId, and the fallback that
    # does not go through it only runs when ours is the sole instance -- but a Quit() is irreversible,
    # so it is gated on that fact holding, not on our believing it does.
    $ownsDte = $dte -and $launchedId -and (Get-Process -Id $launchedId -ErrorAction SilentlyContinue)
    if ($ownsDte) {
        try { $dte.Solution.Close($false) } catch { }
        try { $dte.Quit() } catch { }
        Wait-Pumped -Milliseconds 2000
    } elseif ($dte) {
        Write-Host "NOTE: not quitting the IDE -- the process we launched is already gone."
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
    try { Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

exit $exitCode
