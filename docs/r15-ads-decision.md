# R15 ADS online monitoring: decision brief

Researched 2026-11-12. **(V)** means checked against a primary source (npm registry, library source, Beckhoff Infosys, Beckhoff's MIT ADS library, GitHub issue pages). **(I)** means our inference or design advice. **(U)** means not verified. Where the research reports disagreed, this brief follows the verification pass.

## 1. Recommendation

Build R15 on the npm library **`ads-client` 2.2.0** (MIT, pure JavaScript, no native code). Ship phase 1 as **read-only monitoring plus a confirmed one-off "Write value"**, with no "Force". Documented ADS has no force service.

Before we commit to the default connection path, it has to be checked on your Windows machine. On TwinCAT 3.1.4026 with the **user-mode runtime**, ads-client may not reach the local TwinCAT router at all (section 6).

## 2. Library options

| Library | Licence | Native deps | Maintenance | Notifications | Works with the local TwinCAT router | Remote/direct route needs |
|---|---|---|---|---|---|---|
| **`ads-client` 2.2.0 (recommended)** | MIT (V). Its dependencies are `debug`, `ms`, `iconv-lite` and `safer-buffer` (all MIT) and `long` (Apache-2.0) (V) | None; it uses only Node's `net` and `events` (V) | Active, one main maintainer. 2.2.0 released 2025-12-27; last commit 2026-10-10; about 22k downloads/month (V) | Yes, device notifications with cycle time and on-change mode; subscriptions are restored after a TwinCAT restart since 2.1.0 (V) | Yes, by registering a port on 127.0.0.1:48898 (V). That handshake is **not in Beckhoff's published spec** (V), and it is reported broken on the 4026 user-mode runtime (section 6) | Direct mode works: set the local NetId and port by hand, and add a route on the PLC to the PC's IP and NetId (V). Only one connection per client IP (V) |
| `node-ads` 1.5.1 | MIT (declared; no LICENSE file) (V) | None (V) | Abandoned; last release 2020-07-20 (V) | Yes, but you declare each variable's byte length and type by hand (V) | No, direct only (V) | Route on the PLC. Collides with XAE's own connection from the same PC (its README warns of this) (V) |
| `node-ads-api` 1.4.17 | MIT (V) | None (V) | Abandoned; 2021-05-19 (V) | Same as node-ads (V) | No (V) | Same as node-ads (V) |
| `twincat-ads` 0.9.3 | MIT (V) | None (V) | Abandoned; 2018 (V) | Yes (V) | No (V) | Same; its default target port is 801 (TC2) (V) |
| `beckhoff-js` 0.1.0 | Apache-2.0 (V) | None (V) | Abandoned; 2020 (V) | Yes (V) | No (V) | Direct only (V) |
| `node-beckhoff` | GPL-3.0 (V) | Native `sqlite3` (V) | n/a | n/a | n/a | **Excluded:** licence and native code |
| Beckhoff/ADS (C++) | MIT (V) | Native addon needed (I) | Beckhoff | n/a | n/a | **Excluded:** needs a build step and native code |

No official Beckhoff ADS client exists on npm (I, based on searches).

**Known ads-client defects that we would need to work around:**
- **Issue #189** (open, confirmed in the code at `dist/ads-client.js:1562`) (V). A notification parse error on a 64-bit value (LINT, ULINT or LWORD) throws inside an error handler, and the result is an unhandled promise rejection.
  - Mitigation: pin the exact version and guard or patch it locally; MIT allows that.
  - How VS Code's extension host reacts to the rejection is **(U)**.
- **Issue #172**: subscriptions are lost after a quick re-drop of the connection **(U; not opened by the verifier)**.
- **No Secure ADS (TLS)** in the library (V). Secure ADS is router-to-router anyway, so it only helps when a local router is in the path (I).

## 3. What "force" can and cannot mean over ADS

**Verified facts:**
- In TwinCAT, *write* sets a variable once, and the program can overwrite it. *Force* re-applies the value at the start and the end of every cycle until you unforce it (V, Infosys tc3_plc_intro/2527602315).
  - Forces can be kept on the runtime after logout.
  - A forced value can persist after unforcing.
  - TEMP variables cannot be forced.
  - Beckhoff warns of machine damage and injury.
- **No force service exists in Beckhoff's published ADS index groups** (V): not in the Infosys index table and not in the `AdsDef.h` of Beckhoff's MIT ADS library. XAE forces through its own, undocumented online services (I).
- ads-client has no force API (V).
- Readable by symbol since 4026.21: `TwinCAT_SystemInfoVarList._AppInfo.ActivePlcForces` and `.ActiveIoForces`, which are TRUE while forces are active (V).

**Options:**

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A. Write only (recommended)** | One ADS write, after a confirmation | Documented, honest, simple | No hold |
| **A+. Write plus a force indicator (recommended add-on)** | Read `ActivePlcForces`/`ActiveIoForces` and show "Forces active on target (set from XAE)" | Read-only and documented; warns you about forces set elsewhere | Only on 4026.21 and later |
| B. Extension-side "hold" | The extension rewrites the value whenever a notification shows the PLC changed it | Gives a sticky value | **Not a force.** It races the PLC cycle, so your code sees its own value in between. XAE's force list does not show it, and it stops when VS Code closes or the link drops. Must never be called "Force". Of the two reports, one said offer it with an honest label and one said never offer it |
| C. Real IEC force | Reverse-engineer XAE's online services | Matches XAE | Undocumented and contradicts R15's "documented protocol" premise. Not recommended |

## 4. UX options

**Inline values in the editor panes.** All three techniques are available in the vendored Monaco 0.39.0 (V).
- **Decorations with injected text (recommended):** a value box after the variable. Injected text does not change the document (V), so save and the XML round trip stay byte-identical.
- **Inlay hints:** pull-based, so every refresh tick would go through Monaco's provider machinery (I). Not recommended.
- **Hover only:** cheap, but you see a value only while the mouse rests on the variable.
- VS Code's built-in "inline values" API works only when a debugger is stopped (V). It does not fit a running PLC and does not reach our webview (I).

**Watch view.** A "PLC Watch" tree in the TC Toolkit sidebar (I):
- It holds a list of symbols, with struct, FB and array members expandable.
- Value and type are shown next to each name.
- Right-click offers Write value..., Remove and Copy path.

XAE has the equivalent watch lists and a "Watch all forces" view (V).

**Refresh model (I):**
- **Inline values:** poll the visible variables with one sum read per tick, every 250–500 ms (configurable).
- **Watch view:** use on-change notifications. Beckhoff recommends at most 550 notifications per device (V), so cap the total well below that.
- Pause monitoring while an editor is hidden; a hidden webview cannot receive messages anyway (V).
- Dim values when they are stale or the PLC is stopped.

**Mapping editor names to ADS paths (I, from documented facts):**

| Variable | ADS path |
|---|---|
| GVL variable | `GVL.var` |
| PROGRAM variable | `MAIN.var` |
| FB variable | `<instance path>.var`; you pick the instance |
| METHOD/FUNCTION local or VAR_TEMP | Not monitorable; XAE also needs a breakpoint for these (V) |
| Variable with `{attribute 'hide'}` or `TcNoSymbol` | Has no ADS symbol (V) |
| Property | Only with `{attribute 'monitoring' := 'call'}` (V) |

Every built path is checked against the PLC's uploaded symbol table before use.

**Recommended phase 1:**
1. **TC Toolkit: Go Online...**
   - Inputs: AMS Net ID and port, 851 by default; port = 850 + runtime number (V).
   - A status-bar item shows Offline, Run, Stop, Differs or Forces active.
2. **Inline values** in the Implementation pane (injected text) and at the end of each line in the Declaration pane, for PROGRAM and GVL variables.
   - The FB instance picker can come later in phase 1 or in phase 2.
3. **Write value** with a modal confirmation that shows the target, the path, the old and new values, and the PLC state. Writes are off by default and opt-in.
4. A **force indicator** from `_AppInfo`.
5. A **code-mismatch guard:**
   - On connect, compare `_AppInfo.ProjectName` with the local project. An online change shows up in `OnlineChangeCnt`, a download in the symbol version (V).
   - Hide values and block writes for symbols whose online type or size differs, and on lines with unsaved edits.

The **watch view** follows in phase 2. It reuses the same connection module.

## 5. Decisions (user, 2026-11-13)

Decided by the user as cards on 2026-11-13: **D1** `ads-client` 2.2.0 pinned; **D2** write + a "forces active" indicator, nothing called Force; **D3** local router first, direct mode only as an explicit setting; **D4** ship with a clear error if the 4026 user-mode runtime fails; **D5** writes off by default, enabled per session, each write confirmed and logged, blocked on a code mismatch or unsaved edits; **D6** phase 1 = inline values, Go Online, write, forces indicator, mismatch guard **and a Watch view** (not deferred); **D7/D9** routes stay in XAE, remote development later; **D8** inline 500 ms, watch 200 ms on change, well under 550 notifications.

The table below is the brief as proposed.


| # | Decision | Recommended default |
|---|---|---|
| D1 | Library | `ads-client`, pinned to exactly 2.2.0, as a normal npm dependency. Ship all six licence texts in the VSIX (including Apache-2.0 for `long`, plus any NOTICE). Patch #189 locally if needed |
| D2 | What "force" means in R15 | Option A+: write only, plus a "forces active" indicator. Do not call anything "Force". Decide whether option B (an honestly labelled hold) is ever wanted; recommended **no** for now |
| D3 | Connection modes supported at launch | **Local router first** (an engineering PC with TwinCAT that already has a route to the PLC). Offer **direct mode** only as an explicit setting for PCs without TwinCAT. Never fall back to direct mode silently while a local router is running |
| D4 | Must the 4026 user-mode runtime work at launch? | Depends on your Windows check (section 6). If ads-client fails there, ship with a clear error message and documented workarounds rather than block R15 |
| D5 | Are writes allowed at all, and how? | Off by default (a `tcToolkit.*` setting) and enabled per session. Every write needs a modal confirmation and is logged to an output channel. Writes are blocked while the code differs or the editor has unsaved edits |
| D6 | Phase 1 scope | Inline values, Go Online, write, force indicator and mismatch guard. Watch view in phase 2 |
| D7 | Routes | The extension never creates routes or stores route credentials. You set routes up in XAE, as today, and the extension documents the steps |
| D8 | Refresh rate and load | Inline poll at 500 ms by default; watch notifications at 200 ms on change; total notifications capped well below 550 (Beckhoff's recommendation) |
| D9 | Remote development (Remote-SSH, WSL) | Out of scope for phase 1. There, 127.0.0.1 would point at the remote host. Add a router-address setting (I, untested) |

## 6. Risks, and what needs your Windows check

**Risks**

1. **The 4026 user-mode runtime is the largest risk.**
   - From 4026.21, user mode is the **default on Windows 10 20H2+/Windows 11 with Hyper-V enabled (e.g. VBS)** (V, Infosys tc3_installation/20830884491). That describes most modern engineering laptops.
   - ads-client's maintainer filed issue #196 (open, no fix): the library does not work with a local user-mode runtime (V).
   - The library's master README says that even reaching a *remote* PLC through the local router needs a kernel-mode runtime on 4026. That text comes from a contributor's PR and is not in the 2.2.0 package; Beckhoff has not confirmed it **(U)**.
   - The suggested workaround is switching to kernel mode (`tcpkg config set -n xarMode -v KM`, with Hyper-V and Memory Integrity off). It appears in the README only **(U)**.
2. **The local-router handshake is outside the published spec** (V). It works in practice, but Beckhoff can change it, as 4026 user mode suggests. The documented alternative is Beckhoff's own router DLL or .NET stack. Using either from Node would need native code or Beckhoff binaries, which our constraints exclude (I).
3. **Direct mode collides with XAE.** A TwinCAT router accepts one ADS TCP connection per client IP (V, Beckhoff/ADS #201). A direct connection from a PC that also runs XAE can drop XAE's connection to the PLC (I, consistent with node-ads's README warning).
4. **PLC load.** Each ADS request locks the PLC task briefly, and too many reads load the system (V). Keep reads batched and capped.
5. **Security.** Plain ADS on TCP 48898 is unencrypted (V). Authorisation is only the route (I). Keep writes opt-in and confirmed.
6. **Stale code.** An online change does not change the symbol version (V). Handles may need re-creating after an online change **(U)**.
7. **Library defects** #189 and #172 (section 2).

**Please check on your Windows machine**

1. Your TwinCAT build and runtime mode: user mode or kernel mode, and whether Hyper-V or VBS is on.
2. Whether ads-client in its default mode (127.0.0.1:48898, no NetId configured) connects and reads `TwinCAT_SystemInfoVarList._AppInfo.ProjectName`:
   - (a) from a PC with XAE only, against a remote PLC that already has a route;
   - (b) against the local runtime, if you have one.

   Do each in user mode and, if possible, in kernel mode.
3. With XAE logged in to the same PLC at the same time, whether XAE stays connected while the test client runs.
4. Whether a LINT or ULINT watch triggers the #189 crash path.
5. Whether `.tmc` `ChangeDate` matches the online `_AppInfo.AppTimestamp`; this is undocumented **(U)**. It would give a cheap "code differs" banner.
6. Whether symbol names are case-sensitive when looked up by name **(U)**.

**Facts still unverified, not to be quoted in docs yet:**
- The registry value `EnableAmsTcpLoopback` and "loopback on by default from 4024.5"; ads-client's README is the only source.
- UDP 48899 for adding routes; Beckhoff documents 48899 only as discovery.
- The 500-sub-command sum limit, from search excerpts only.
- Port ranges beyond the AmsPort enum.
- Whether UTF-8 symbols are required on 4026.
- How `monitoring := 'variable'` properties behave over ADS.
