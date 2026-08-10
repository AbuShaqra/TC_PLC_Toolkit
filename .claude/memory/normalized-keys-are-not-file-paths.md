---
name: normalized-keys-are-not-file-paths
description: A normalized (lowercased) path is an identity KEY — minting uris, labels or file reads from it ships a user-visible bug that every headless gate misses.
metadata:
  type: project
---

`normalizeProjectPath()` lowercases so ownership and membership compare reliably on Windows. 0.6.0
fed those normalized paths into `indexXmlFile()`, so every scan-time symbol node's uri was fully
lowercased. Every headless layer stayed green — the LSP resolved definitions and references
correctly against the user's real workspace, the host mapping mapped, the webview rendered — yet
the user correctly reported "definitions and references are broken": `vscode.openWith()` treats a
differently-cased uri as a **different resource**, so every cross-file navigation opened a
DUPLICATE editor tab titled `gvl_system.tcgvl` with nothing highlighted.

**Why:** an identity key answers "are these the same file?"; a path/uri answers "what do I open and
show?". Conflating them is invisible to any test that compares case-insensitively — the existing
guards asserted `/LineA/i`, which passes on both spellings *by construction*.

**How to apply:**
- Keep the two roles in separate fields (`objectPaths` = normalized keys, `objectFiles` = key →
  on-disk spelling in `src/lsp/projectMap.js`), and never build a uri, tab, label or file read from
  the key side.
- Pin casing with case-SENSITIVE assertions (`uri.includes('POUs/MAIN.TcPOU')`), never `/…/i`.
- Anything whose failure mode is "VS Code itself treats these as two resources" can only be proven
  in a real dev host — `test/devhost/run.js` automates exactly that (tab reuse + live client), run
  it whenever navigation identity or uri spelling changes.
- Same incident surfaced a sibling bug in the same regex: `.plcproj` `Include` values are
  XML-attribute-encoded, and undecoded `&amp;` made 57 of OSCAT's 819 objects silently unindexable.
  Paths that leave an XML attribute must pass through entity decoding.

Related: [[multi-project-workspaces]], [[reproduce-on-real-artifacts]].
