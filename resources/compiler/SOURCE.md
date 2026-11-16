# Bundled compiler: source and licences

This directory holds the external IEC 61131-3 compiler that *TC Toolkit: Build Project* runs, as
a separate Node.js process. It is **STruC++**, distributed under the **GNU General Public
License version 3** (`LICENSE`; the licensing overview is `COPYING`, the runtime library
exception `COPYING.RUNTIME`). The extension's own licence does not cover these files.

## Corresponding source

- Repository: https://github.com/AbuShaqra/STruCpp
- Commit: `d9b7c01512307a06f1e1d798ef77803109b7934a`
- Source at that commit: https://github.com/AbuShaqra/STruCpp/tree/d9b7c01512307a06f1e1d798ef77803109b7934a
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
| `compiler.cjs` | 2013483 | `f70de3f1fcbd57a87e70c3160b665387535ed3c359e9dc1258ae335c45dc0e4f` |
| `libs/iec-standard-fb.stlib` | 109394 | `e8987b45e6a1d334889381ea32eaa4158fd6f63fa28c7e1ff46be681f9c1cde5` |
| `libs/iec-std-functions.stlib` | 29170 | `dfeb3f77a04ed04d6faef2ca73df39d1d68f156464f5996454a47cb20e1d9e91` |
| `include/debug_dispatch.hpp` | 43222 | `7d19157473d5e63b089247f1a4d265e122d563a62a651cb66cd65b5febd4e45b` |
| `include/debug_table.hpp` | 10127 | `3aa4da7a12d49111d3b1d4787eca999a9255df1941674b93ee9e9cec230b7467` |
| `include/iec_array.hpp` | 24546 | `64b9a865e82d6c77f8813d61c5133b3b8cdc2b02b7bcd97dfbc9834021eadb98` |
| `include/iec_char.hpp` | 6093 | `369f2378cf3e954ceeee3c716d1293913c77b0bfafcb25b45917709a1519f103` |
| `include/iec_cp1252.hpp` | 5100 | `ffd554ca3b28ad2312eddba086e827980a9eff018b26109a02249d3eaf4c88bd` |
| `include/iec_date.hpp` | 8021 | `79b74df58e43070a6e61ab544930c04aba268c14cf0912a23715703ec74bb870` |
| `include/iec_dt.hpp` | 12106 | `156a279f3bcd2b845e325a90e5ab4f530f9f3e6152870927c53d1a53751be4ce` |
| `include/iec_enum.hpp` | 7070 | `2dd65e74c372ed41ab9177ddf29b10b190f3183a4008fe44ba10c194d72d2b84` |
| `include/iec_fault.hpp` | 13952 | `308e0f4ddd15089ce8f274f1a6ebe896a61b60ae46262042f3f1444c45fd9a65` |
| `include/iec_force.hpp` | 21772 | `236bc34199deaa6ed0c87a330a4bac318134951dc351f84db749e49fab272211` |
| `include/iec_global.hpp` | 5973 | `d2704b71e9ef020abc7a291a908eec2529ba1bc229170a76f63d8a8a0555fa79` |
| `include/iec_located.hpp` | 7767 | `b0977c93a798453c4d2d2c202658a4e70a13aac0c88924c2f9d58a1a6cecdb48` |
| `include/iec_memory.hpp` | 2488 | `a1f957d08c1ad0b73ee8c13f736bd510b9d43a79e6d4655debcbcfe8ae109d80` |
| `include/iec_pointer.hpp` | 28312 | `40fc7c79448ab9a5be6b6045262b6304d9607f65470f286ccf3275b38fd2680f` |
| `include/iec_ptr.hpp` | 12916 | `5fb82eef9dfa7165320e34fc4c7718ad26586881fe0bbefc3d281e1f50d79699` |
| `include/iec_retain.hpp` | 13561 | `50c76344ed8069c9accb948f65187a2497a84d86182307b26fa15e8ef8d89600` |
| `include/iec_std_lib.hpp` | 87771 | `a31c94334674f1462b237343584240003658e8d9e0b39ba67fa8a28d25b6039e` |
| `include/iec_string.hpp` | 39685 | `07e139063883be29f073f3fa182227a543e4f97a2b19a87beb7ac23e92ec81ad` |
| `include/iec_struct.hpp` | 3757 | `5749c578bbf2222408b055df9e02cd6a11fc18a9eb751e12861505c7a9a9f99e` |
| `include/iec_subrange.hpp` | 11126 | `0e4a4a956dd2e017fbb4a9ca8e93a8aa89a5b9c84dae81d3464896c1032ae8d1` |
| `include/iec_time.hpp` | 8046 | `718bd8bd52358596a4b014fb1ef319dd0f965cfbbf2ee1fc15166b73a27a90f2` |
| `include/iec_tod.hpp` | 6961 | `1d12d0730135bf1e1c1a2c4749bf79679ca1f14b3c3890e677f1c1e7e5068dbf` |
| `include/iec_traits.hpp` | 24328 | `14bb3437d29dc47efca6ebd3462646edc4cb21c92cdd7662e206b0495f6b9376` |
| `include/iec_types.hpp` | 19068 | `2857c36904b78104cd1d66cfb4c4f2270bd7214b41a0cdb97c786119c5e18fe8` |
| `include/iec_union.hpp` | 24516 | `0f2386aed1ec2700aa43aad7bf3cd17949f1f918d44811094a40ad57cb2e0f6d` |
| `include/iec_var.hpp` | 29216 | `17bf2fe39063a6c5d975a6357ea675d83fb11f15b71cb8ccc2b691a65ba6b633` |
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
