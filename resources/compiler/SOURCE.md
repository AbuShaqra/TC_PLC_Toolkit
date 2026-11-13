# Bundled compiler: source and licences

This directory holds the external IEC 61131-3 compiler that *TC Toolkit: Build Project* runs, as
a separate Node.js process. It is **STruC++**, distributed under the **GNU General Public
License version 3** (`LICENSE`; the licensing overview is `COPYING`, the runtime library
exception `COPYING.RUNTIME`). The extension's own licence does not cover these files.

## Corresponding source

- Repository: https://github.com/AbuShaqra/STruCpp
- Commit: `75a55de28133cfbdb8af4742af5dd20bf9ce385d`
- Source at that commit: https://github.com/AbuShaqra/STruCpp/tree/75a55de28133cfbdb8af4742af5dd20bf9ce385d
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
27 of the 27 headers carry that SPDX line themselves.

## Files

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `compiler.cjs` | 1807556 | `0a7ee5c965599bf0d601579fdb43bf9eacff72f2246feb58bfa28cd25ddec407` |
| `libs/iec-standard-fb.stlib` | 104480 | `659f139c54db12e6fd8ec383bd686f49d07c66fa56b2af784e7e04ce0f8d35b1` |
| `libs/iec-std-functions.stlib` | 29044 | `0394d84e8cb3c0c08ee8515bb31197941b81a23516643f516b0b1967e26870ea` |
| `include/debug_dispatch.hpp` | 42573 | `a3847f82504fd9e00f631d99775eaf4c279ec595b7806c76ccf496427bd7b3ad` |
| `include/debug_table.hpp` | 9859 | `3fd5b56cd1b74f2e45f3c39a799e50751c70c22a10fddf7a61f51f4ed3278871` |
| `include/iec_array.hpp` | 24336 | `05d7f60c43c681bd481ca31b9ca4ae75f2fe30665e4ba1097cb04db841e334a7` |
| `include/iec_char.hpp` | 6093 | `369f2378cf3e954ceeee3c716d1293913c77b0bfafcb25b45917709a1519f103` |
| `include/iec_cp1252.hpp` | 5100 | `ffd554ca3b28ad2312eddba086e827980a9eff018b26109a02249d3eaf4c88bd` |
| `include/iec_date.hpp` | 5599 | `5620c4a973aed7f055f1c611ac76fd25f70d5f4aba759408355fdf6e29083f55` |
| `include/iec_dt.hpp` | 6045 | `f81060f7584b158c9b5dbc36b991c734004b9ec1022ba82df4bcfcfcaabaccc9` |
| `include/iec_enum.hpp` | 7070 | `2dd65e74c372ed41ab9177ddf29b10b190f3183a4008fe44ba10c194d72d2b84` |
| `include/iec_fault.hpp` | 3211 | `85774af0220f7f330802592fb7a87a5476bfcaca5ba1f74c197d491ec8cced78` |
| `include/iec_force.hpp` | 21772 | `236bc34199deaa6ed0c87a330a4bac318134951dc351f84db749e49fab272211` |
| `include/iec_global.hpp` | 5973 | `d2704b71e9ef020abc7a291a908eec2529ba1bc229170a76f63d8a8a0555fa79` |
| `include/iec_located.hpp` | 7767 | `b0977c93a798453c4d2d2c202658a4e70a13aac0c88924c2f9d58a1a6cecdb48` |
| `include/iec_memory.hpp` | 2488 | `a1f957d08c1ad0b73ee8c13f736bd510b9d43a79e6d4655debcbcfe8ae109d80` |
| `include/iec_pointer.hpp` | 26048 | `13bd78e325a32f2a0a66a3928d73200cbe64794cd73fb58ebaec5e1d66b11d35` |
| `include/iec_ptr.hpp` | 11087 | `df71ffa94d9d8776879192dbfdec5187aa51414d03b68a847a0acf64f15b6a41` |
| `include/iec_retain.hpp` | 13493 | `f4f9b9977b91ee103133741574f5333ad6a135a508c22914348f05c0fb586f9b` |
| `include/iec_std_lib.hpp` | 69261 | `630cf87208a157f3231fc81faf3b54addbd2c6642b0091278f9c633eec3395af` |
| `include/iec_string.hpp` | 38620 | `c5f085245a605c03f291fe5efce65c748592d10cb8799e92699dc655d76d0b3b` |
| `include/iec_struct.hpp` | 3757 | `5749c578bbf2222408b055df9e02cd6a11fc18a9eb751e12861505c7a9a9f99e` |
| `include/iec_subrange.hpp` | 11126 | `0e4a4a956dd2e017fbb4a9ca8e93a8aa89a5b9c84dae81d3464896c1032ae8d1` |
| `include/iec_time.hpp` | 5561 | `4358e2bbf271f14c3d1678b7010984aad3b3dea167f821c237da3a02a3338c4f` |
| `include/iec_tod.hpp` | 5101 | `b1fbc237f249fe9e2376e06c0050b89a8d54895145493d0470d1bab2e4d4e988` |
| `include/iec_traits.hpp` | 23684 | `c91b4588ccad2a3f76d64175016ae6201e79640ca5a22b6f7106d8bb604638b4` |
| `include/iec_types.hpp` | 11157 | `2e7797d93e70cfa85fbd264dfaa1251bd0a83d5acbc802d1154565992d10664f` |
| `include/iec_union.hpp` | 24417 | `2e2c090498b63bc1b4c7af7dd04dcb61b31901fe3e77cc9b9217fe93d4e4ba38` |
| `include/iec_var.hpp` | 22194 | `0676eb676ef8981965bd208bb57910d28f873675e61f7913e6c53a8900c2815b` |
| `include/iec_wstring.hpp` | 24332 | `0d4207d0dca6b5612efb78e701eac6576ed76ff3f2674ac7304e16e0e52cd2dc` |
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
