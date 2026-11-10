# Third-Party Notices

This extension bundles third-party software. Each component is distributed under
its own license, reproduced or linked below. The root [`LICENSE`](LICENSE)
(AGPL-3.0-or-later © A. AbuShaqra; versions up to 0.10.1 were MIT) applies **only** to the original code of this extension — it
does not cover the bundled components listed here, which remain under the
licenses of their respective owners.

## Monaco Editor

- Version: 0.39.0
- Copyright © Microsoft Corporation
- License: MIT — full text at [`media/monaco-editor/LICENSE.txt`](media/monaco-editor/LICENSE.txt)
- https://github.com/microsoft/monaco-editor

Monaco bundles further components under `media/monaco-editor/vs/`:

- **TypeScript** language services and worker (`vs/language/typescript/`) —
  Copyright © Microsoft Corporation — Apache License 2.0 —
  https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt
- **Basic-language grammars** (`vs/basic-languages/`) — MIT,
  Copyright © Microsoft Corporation and contributors. Individual grammars may
  carry their own copyright (for example the Swift grammar, © David Owens II,
  MIT). These are enumerated in Monaco's upstream notices:
  https://github.com/microsoft/monaco-editor/blob/main/ThirdPartyNotices.txt

## Codicons (icon font)

- File: `media/monaco-editor/vs/base/browser/ui/codicons/codicon/codicon.ttf`
- Copyright © Microsoft Corporation
- License: Creative Commons Attribution 4.0 International (CC-BY-4.0)
- https://github.com/microsoft/vscode-codicons
- License text: https://creativecommons.org/licenses/by/4.0/

## STruC++ (the compiler behind *TwinCAT: Compile Project*)

- Location: `resources/compiler/` (`compiler.cjs`, `libs/`), run as a separate Node.js process —
  never loaded into the extension
- Version: 0.7.0, built from commit `e884d871e358367fb6ad0243d24f6493d0b8ee9d` of
  https://github.com/AbuShaqra/STruCpp (a fork of https://github.com/Autonomy-Logic/STruCpp)
- Copyright © 2025 Autonomy® and contributors (see `resources/compiler/COPYING.RUNTIME`)
- License: GNU General Public License version 3 (GPL-3.0-only) — full text at
  [`resources/compiler/LICENSE`](resources/compiler/LICENSE); licensing overview
  [`resources/compiler/COPYING`](resources/compiler/COPYING) and runtime library exception
  [`resources/compiler/COPYING.RUNTIME`](resources/compiler/COPYING.RUNTIME)
- Corresponding source: the commit above —
  https://github.com/AbuShaqra/STruCpp/tree/e884d871e358367fb6ad0243d24f6493d0b8ee9d — with the
  build command and a checksum of every file in
  [`resources/compiler/SOURCE.md`](resources/compiler/SOURCE.md)

`compiler.cjs` is a single-file bundle that contains:

| Package | Version | License | License text |
| --- | --- | --- | --- |
| chevrotain, @chevrotain/gast, @chevrotain/regexp-to-ast, @chevrotain/utils | 11.0.3 | Apache-2.0 | [`resources/compiler/third-party/chevrotain-LICENSE.txt`](resources/compiler/third-party/chevrotain-LICENSE.txt) |
| lodash-es | 4.17.21 | MIT | [`resources/compiler/third-party/lodash-es-LICENSE.txt`](resources/compiler/third-party/lodash-es-LICENSE.txt) |

## Runtime dependencies (bundled under `node_modules/`)

Each package retains its own `LICENSE` file inside `node_modules/`:

| Package | License |
| --- | --- |
| vscode-languageclient | MIT |
| vscode-languageserver | MIT |
| vscode-languageserver-protocol | MIT |
| vscode-languageserver-textdocument | MIT |
| vscode-languageserver-types | MIT |
| vscode-jsonrpc | MIT |
| brace-expansion | MIT |
| balanced-match | MIT |
| minimatch | ISC |
| semver | ISC |

Copyright © their respective authors (Microsoft and contributors).

---

*Keep this file in sync with the bundled components. It ships in the VSIX so
that recipients receive the required notices.*
