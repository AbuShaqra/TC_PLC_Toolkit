# Bundled compiler: source and licences

This directory holds the external IEC 61131-3 compiler that *TC Toolkit: Compile Project* runs, as
a separate Node.js process. It is **STruC++**, distributed under the **GNU General Public
License version 3** (`LICENSE`; the licensing overview is `COPYING`, the runtime library
exception `COPYING.RUNTIME`). The extension's own licence does not cover these files.

## Corresponding source

- Repository: https://github.com/AbuShaqra/STruCpp
- Commit: `e884d871e358367fb6ad0243d24f6493d0b8ee9d`
- Source at that commit: https://github.com/AbuShaqra/STruCpp/tree/e884d871e358367fb6ad0243d24f6493d0b8ee9d
- Compiler version: 0.7.0
- Built with: `npm ci && npm run build:bundle` (Node.js 22 or newer)
- `compiler.cjs` is that build's `dist/strucpp-bundle.cjs`, renamed; `libs/` holds two of the
  libraries the same build writes to `libs/` (their sources are under `libs/sources/` in the
  repository).

## Files

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `compiler.cjs` | 1545225 | `bd9c686363146786e6e13546aa0e25bdd18c0dc7db622e51e619c3a3b76d2104` |
| `libs/iec-standard-fb.stlib` | 51138 | `a7763d4218c10837f7ddbf205d8f2d8f9ec34b13bbcd384cb565043bef9a64bb` |
| `libs/iec-std-functions.stlib` | 27504 | `6fdc4bcbbfd2d75883b6c6b281f3ca09f1d64870ebcfdf33d7540c8e979e8b67` |
| `LICENSE` | 35149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| `COPYING` | 3031 | `c3aa2fa4d74677e5d8a1a6a87a8b56a48372a751f2d0cb27efc856dc903f5c4e` |
| `COPYING.RUNTIME` | 2410 | `2a130ebb008c28e7aea8e6014295636a14e86fe26295b825a38b5acac65a4916` |
| `third-party/chevrotain-LICENSE.txt` | 11358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `third-party/lodash-es-LICENSE.txt` | 1952 | `f71e8ed126b46346494aad5486874cd8f0aafe95092ed67d2e3cb6110f939abc` |

## Third-party components inside `compiler.cjs`

| Package | Version | Licence | Licence text |
| --- | --- | --- | --- |
| chevrotain | 11.0.3 | Apache-2.0 | `third-party/chevrotain-LICENSE.txt` |
| @chevrotain/gast | 11.0.3 | Apache-2.0 | `third-party/chevrotain-LICENSE.txt` |
| @chevrotain/regexp-to-ast | 11.0.3 | Apache-2.0 | `third-party/chevrotain-LICENSE.txt` |
| @chevrotain/utils | 11.0.3 | Apache-2.0 | `third-party/chevrotain-LICENSE.txt` |
| lodash-es | 4.17.21 | MIT | `third-party/lodash-es-LICENSE.txt` |

Written by `scripts/vendor-compiler.js`; do not edit by hand.
