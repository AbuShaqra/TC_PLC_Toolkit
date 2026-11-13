# Bundled compiler: source and licences

This directory holds the external IEC 61131-3 compiler that *TC Toolkit: Build Project* runs, as
a separate Node.js process. It is **STruC++**, distributed under the **GNU General Public
License version 3** (`LICENSE`; the licensing overview is `COPYING`, the runtime library
exception `COPYING.RUNTIME`). The extension's own licence does not cover these files.

## Corresponding source

- Repository: https://github.com/AbuShaqra/STruCpp
- Commit: `eb52d2cab39ffd2eeaf69ea06c5c1454eae8d95c`
- Source at that commit: https://github.com/AbuShaqra/STruCpp/tree/eb52d2cab39ffd2eeaf69ea06c5c1454eae8d95c
- Compiler version: 0.7.0
- Built with: `npm ci && npm run build:bundle` (Node.js 22 or newer)
- `compiler.cjs` is that build's `dist/strucpp-bundle.cjs`, renamed; `libs/` holds two of the
  libraries the same build writes to `libs/` (their sources are under `libs/sources/` in the
  repository).
- `include/` holds the C++ runtime headers of the same commit (`src/runtime/include/`, every
  `.hpp`). Build Project's optional g++ build compiles the generated C++ against them.

## Licence of the runtime headers

The fork's `COPYING` lists `src/runtime/include/*.hpp` as **GPL-3.0-only WITH
STruCpp-runtime-exception** (`LICENSE` and `COPYING.RUNTIME`): the exception lets C++ generated
from a user's program include them without the program becoming GPL-licensed.
24 of the 26 headers carry that SPDX line themselves; `iec_fault.hpp` and `iec_global.hpp` carry no per-file notice and are covered by `COPYING`'s file list only.

## Files

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `compiler.cjs` | 1663739 | `07eb9319860b450e571074e6beeb277d4a3ced8369a9adb71dbe4183744ae3b7` |
| `libs/iec-standard-fb.stlib` | 51736 | `2076bf05fd4c1d67115237834880a73a2273c003167d07f00901479513f74fb3` |
| `libs/iec-std-functions.stlib` | 27504 | `6fdc4bcbbfd2d75883b6c6b281f3ca09f1d64870ebcfdf33d7540c8e979e8b67` |
| `include/debug_dispatch.hpp` | 37243 | `58b38e5be927a424288b71e3cc7546c1973ba18e4afe0c5cd18bad5a1caca77a` |
| `include/debug_table.hpp` | 9167 | `f7b84f192def0e95ef127c156707d980323e8ae59f82d282349b1ce6ed276ed6` |
| `include/iec_array.hpp` | 24336 | `05d7f60c43c681bd481ca31b9ca4ae75f2fe30665e4ba1097cb04db841e334a7` |
| `include/iec_char.hpp` | 5892 | `8230377ac2ba65229da408b3da5b88f0dbceeda00c17ccc3b0642a04c7c862e8` |
| `include/iec_date.hpp` | 5599 | `5620c4a973aed7f055f1c611ac76fd25f70d5f4aba759408355fdf6e29083f55` |
| `include/iec_dt.hpp` | 6045 | `f81060f7584b158c9b5dbc36b991c734004b9ec1022ba82df4bcfcfcaabaccc9` |
| `include/iec_enum.hpp` | 7070 | `2dd65e74c372ed41ab9177ddf29b10b190f3183a4008fe44ba10c194d72d2b84` |
| `include/iec_fault.hpp` | 2636 | `fb5696d0051cfcce97904a85c6d7b56045e266f781627fbe5ad9d765bc0ba841` |
| `include/iec_force.hpp` | 15293 | `2e5bc7efade5c1bf5d2b5980f00a69e16763cc470aa8bcdc117ba1d696b52ede` |
| `include/iec_global.hpp` | 5580 | `dfab3fa14bff59054b118a77afb565e140d5eeaabe9c2b2f8d72ed7bdfd96441` |
| `include/iec_located.hpp` | 7767 | `b0977c93a798453c4d2d2c202658a4e70a13aac0c88924c2f9d58a1a6cecdb48` |
| `include/iec_memory.hpp` | 2488 | `a1f957d08c1ad0b73ee8c13f736bd510b9d43a79e6d4655debcbcfe8ae109d80` |
| `include/iec_pointer.hpp` | 26048 | `13bd78e325a32f2a0a66a3928d73200cbe64794cd73fb58ebaec5e1d66b11d35` |
| `include/iec_ptr.hpp` | 11087 | `df71ffa94d9d8776879192dbfdec5187aa51414d03b68a847a0acf64f15b6a41` |
| `include/iec_retain.hpp` | 13493 | `f4f9b9977b91ee103133741574f5333ad6a135a508c22914348f05c0fb586f9b` |
| `include/iec_std_lib.hpp` | 62420 | `580df150b54a938c4f0190fe159278f7471e6f65181a3f82f260153c268f4874` |
| `include/iec_string.hpp` | 38092 | `5bc4644092da74238f80e1beb06208007cb8b351afee686777366eb2ecb69a9f` |
| `include/iec_struct.hpp` | 3757 | `5749c578bbf2222408b055df9e02cd6a11fc18a9eb751e12861505c7a9a9f99e` |
| `include/iec_subrange.hpp` | 11047 | `0862332f8dde70339bae872ffebe041de8dced0a26067b5f726af552f5a30142` |
| `include/iec_time.hpp` | 5098 | `4e4eafff96c1bc38905b0e419828845845af9c03a1accc033b3f01b1914d2595` |
| `include/iec_tod.hpp` | 5101 | `b1fbc237f249fe9e2376e06c0050b89a8d54895145493d0470d1bab2e4d4e988` |
| `include/iec_traits.hpp` | 23684 | `c91b4588ccad2a3f76d64175016ae6201e79640ca5a22b6f7106d8bb604638b4` |
| `include/iec_types.hpp` | 11157 | `2e7797d93e70cfa85fbd264dfaa1251bd0a83d5acbc802d1154565992d10664f` |
| `include/iec_union.hpp` | 23203 | `5c6fe3912d78f885579cb2c5aaed92589015c4e42e8db39d985bda44af80587f` |
| `include/iec_var.hpp` | 20158 | `ff3e9384ab86112471b27f0de6b3343dade4d2c61037dade7dd846d4dc6565f9` |
| `include/iec_wstring.hpp` | 23822 | `61cc1bbebe20aba4dfeb631bbf5fd63fd3db9fcac6213d563d2915e40b659366` |
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
