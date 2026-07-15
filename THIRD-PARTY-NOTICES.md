# Third-Party Notices

This extension bundles third-party software. Each component is distributed under
its own license, reproduced or linked below. The root [`LICENSE`](LICENSE)
(MIT © A. AbuShaqra) applies **only** to the original code of this extension — it
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
