---
name: multi-project-workspaces
description: A TwinCAT workspace can hold several .plcproj files; every symbol/name-keyed structure must be scoped per project, never workspace-flat.
metadata:
  type: project
---

Opening a folder with more than one PLC project used to break references, diagnostics and
navigation: the symbol index was one flat map keyed by object name, so two projects' same-named
objects collapsed onto one key (last-write-wins). Measured on two copies of `sample/`: **38 object
files produced 19 index entries**, every shared name resolved to the second copy, correct code got a
false diagnostic, and Find References returned hits from the wrong project.

**Why:** the `.plcproj` — not the workspace folder — is the compilation unit. XAE does not resolve
symbols across PLC projects, so anything keyed by symbol name must be partitioned per project.

**How to apply:** before adding any name-keyed workspace structure, ask which project owns each
entry, and route it through `src/lsp/projectMap.js`. Two traps found the hard way: a file can be
`<Compile>`d by more than one project (a link — index it into every owner, route requests to the one
whose directory contains it), and the **rename config-object scan** must be project-scoped, because
an unscoped walk rewrites the other project's `.TcVIS`/`.TcTLO`/`.TcTTO` and silently breaks its XAE
build. Verify multi-project changes on a real two-project fixture — `test/_multiproject.js` builds
one from the committed sample. And keep the partition's normalized keys OUT of uris and file reads —
that leak shipped 0.6.0's duplicate-tab navigation bug: [[normalized-keys-are-not-file-paths]].
See [[reproduce-on-real-artifacts]].
