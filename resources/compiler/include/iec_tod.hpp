// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC TIME_OF_DAY Standard Functions
 *
 * IEC 61131-3 standard functions on the TIME_OF_DAY (TOD) and LTOD
 * types.  TOD / LTOD are stored as signed nanoseconds since midnight
 * in `IECVar<TOD_t>`, normalised into the [0, 24h) range by the
 * `TOD_NORMALIZE` helper used by the construction + arithmetic
 * functions below.  Codegen emits TOD variables as `IEC_TOD` (the
 * `IECVar<TOD_t>` alias) and the functions take/return `IEC_TOD` so
 * they're directly callable from generated POU code.
 *
 * Scope: only the standard arithmetic / comparison / round-trip
 * functions.  Calendar/clock component accessors (HOUR, MINUTE,
 * SECOND, …) are intentionally NOT here — those are OSCAT-style
 * extensions and user libraries (OSCAT, codesys-v23 stdlib imports)
 * ship their own implementations.  Providing them here would create
 * overload ambiguity when a project imports such a library.
 *
 * Historical note: an earlier `TimeOfDayValue<T>` + `IECTodVar<T>`
 * value-class design lived here.  Codegen never adopted it; the
 * parallel API was dead from generated code's perspective.  Removed
 * in favour of a single IECVar-based surface.  See `iec_time.hpp`
 * for the matching note on the TIME family.
 */

#pragma once

#include <cstdint>
#include "iec_types.hpp"
#include "iec_var.hpp"
#include "iec_traits.hpp"

namespace strucpp {

// TOD is 32-bit milliseconds since midnight, wrapping modulo 2^32 as the
// PLC's does; LTOD is signed 64-bit nanoseconds, kept in [0, 24h).
constexpr int64_t TOD_NS_PER_DAY = IEC_NS_PER_DAY;

// Normalise a signed nanosecond count into the canonical [0, 24h) LTOD range.
inline LTOD_t TOD_NORMALIZE(int64_t ns) noexcept {
    LTOD_t result = static_cast<LTOD_t>(ns % TOD_NS_PER_DAY);
    if (result < 0) result += static_cast<LTOD_t>(TOD_NS_PER_DAY);
    return result;
}

/** Milliseconds as a TOD, modulo 2^32. */
inline TOD_t TOD_OF_MS(int64_t ms) noexcept {
    return TOD_t(static_cast<uint32_t>(static_cast<uint64_t>(ms)));
}

/** A TOD as nanoseconds since midnight (exact). */
inline int64_t TOD_AS_NS(TOD_t t) noexcept { return static_cast<int64_t>(t.raw) * 1000000LL; }

/** Nanoseconds as a TOD: truncated toward zero to ms, modulo 2^32. */
inline TOD_t TOD_OF_NS(int64_t ns) noexcept { return TOD_OF_MS(ns / 1000000LL); }

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------
inline IEC_TOD TOD_FROM_HMS(int hour, int minute, int second,
                            int millisecond = 0) noexcept {
    return IEC_TOD(TOD_OF_MS(static_cast<int64_t>(hour) * 3600000LL +
                             static_cast<int64_t>(minute) * 60000LL +
                             static_cast<int64_t>(second) * 1000LL + millisecond));
}

inline IEC_TOD TOD_FROM_NS(int64_t ns) noexcept { return IEC_TOD(TOD_OF_NS(ns)); }
inline IEC_TOD TOD_FROM_MS(int64_t ms) noexcept { return IEC_TOD(TOD_OF_MS(ms)); }

inline int64_t TOD_TO_NS(IEC_TOD tod) noexcept { return TOD_AS_NS(tod.get()); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TOD_TO_NS(const IECVar<L_>& tod) noexcept { return iec_unwrap(tod); }
inline int64_t TOD_TO_MS(IEC_TOD tod) noexcept { return static_cast<int64_t>(tod.get().raw); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TOD_TO_MS(const IECVar<L_>& tod) noexcept { return iec_unwrap(tod) / 1000000LL; }

// ---------------------------------------------------------------------------
// Arithmetic. TOD +/- a duration wraps modulo 2^32 ms; LTOD stays in
// [0, 24h). `DIFF_TOD` returns a signed difference.
// ---------------------------------------------------------------------------
inline IEC_TOD ADD_TOD(IEC_TOD tod, int64_t ms) noexcept {
    return IEC_TOD(TOD_OF_MS(static_cast<int64_t>(tod.get().raw) + ms));
}
inline IEC_TOD SUB_TOD(IEC_TOD tod, int64_t ms) noexcept {
    return IEC_TOD(TOD_OF_MS(static_cast<int64_t>(tod.get().raw) - ms));
}
inline int64_t DIFF_TOD(IEC_TOD a, IEC_TOD b) noexcept {
    return static_cast<int64_t>(a.get().raw) - static_cast<int64_t>(b.get().raw);
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTOD ADD_TOD(const IECVar<L_>& tod, int64_t ns) noexcept {
    return IEC_LTOD(TOD_NORMALIZE(iec_unwrap(tod) + ns));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTOD SUB_TOD(const IECVar<L_>& tod, int64_t ns) noexcept {
    return IEC_LTOD(TOD_NORMALIZE(iec_unwrap(tod) - ns));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DIFF_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept {
    return iec_unwrap(a) - iec_unwrap(b);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
inline bool GT_TOD(IEC_TOD a, IEC_TOD b) noexcept { return a.get() >  b.get(); }
inline bool GE_TOD(IEC_TOD a, IEC_TOD b) noexcept { return a.get() >= b.get(); }
inline bool EQ_TOD(IEC_TOD a, IEC_TOD b) noexcept { return a.get() == b.get(); }
inline bool NE_TOD(IEC_TOD a, IEC_TOD b) noexcept { return a.get() != b.get(); }
inline bool LE_TOD(IEC_TOD a, IEC_TOD b) noexcept { return a.get() <= b.get(); }
inline bool LT_TOD(IEC_TOD a, IEC_TOD b) noexcept { return a.get() <  b.get(); }

template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GT_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >  iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GE_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool EQ_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) == iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool NE_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) != iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LE_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LT_TOD(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <  iec_unwrap(b); }

} // namespace strucpp
