// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC TIME Standard Functions
 *
 * IEC 61131-3 standard functions on the TIME (and LTIME) duration types.
 * TIME is 32-bit unsigned milliseconds (`TIME_t`, wrapping modulo 2^32);
 * LTIME is signed 64-bit nanoseconds (`LTIME_t`). Each function has a form
 * for each.
 *
 * Historical note: an earlier `TimeValue<T>` + `IECTimeVar<T>` value-
 * class design lived here.  Codegen never adopted it (TIME variables
 * were always declared as `IEC_TIME`), so the parallel API was dead
 * from generated code's perspective.  Removed in favour of a single
 * IECVar-based surface.
 */

#pragma once

#include <cstdint>
#include "iec_types.hpp"
#include "iec_var.hpp"
#include "iec_traits.hpp"

namespace strucpp {

// ---------------------------------------------------------------------------
// Unit constants
// ---------------------------------------------------------------------------
// TIME holds milliseconds in 32 bits (IecTemporal32), LTIME nanoseconds in 64.
constexpr int64_t NS_PER_US = 1000LL;
constexpr int64_t NS_PER_MS = 1000000LL;
constexpr int64_t NS_PER_S = 1000000000LL;
constexpr int64_t NS_PER_M = 60LL * NS_PER_S;
constexpr int64_t NS_PER_H = 60LL * NS_PER_M;
constexpr int64_t NS_PER_D = 24LL * NS_PER_H;

// ---------------------------------------------------------------------------
// TIME <-> LTIME
// ---------------------------------------------------------------------------
/** A TIME as nanoseconds (exact). */
inline int64_t TIME_AS_NS(TIME_t t) noexcept {
    return static_cast<int64_t>(t.raw) * NS_PER_MS;
}
inline int64_t TIME_AS_NS(const IEC_TIME& t) noexcept { return TIME_AS_NS(t.get()); }

/** Nanoseconds as a TIME: truncated toward zero to ms, modulo 2^32. */
inline TIME_t TIME_OF_NS(int64_t ns) noexcept {
    return TIME_t(static_cast<uint32_t>(static_cast<uint64_t>(ns / NS_PER_MS)));
}

// ---------------------------------------------------------------------------
// Conversion: TIME / LTIME -> integer count of the requested unit (truncated)
// ---------------------------------------------------------------------------
// TIME_TO_MS / TIME_TO_S live in `iec_std_lib.hpp` next to the generic
// numeric conversions.
inline int64_t TIME_TO_NS(IEC_TIME t) noexcept { return TIME_AS_NS(t); }
inline int64_t TIME_TO_US(IEC_TIME t) noexcept { return TIME_AS_NS(t) / NS_PER_US; }
inline int64_t TIME_TO_M(IEC_TIME t) noexcept { return TIME_AS_NS(t) / NS_PER_M; }
inline int64_t TIME_TO_H(IEC_TIME t) noexcept { return TIME_AS_NS(t) / NS_PER_H; }
inline int64_t TIME_TO_D(IEC_TIME t) noexcept { return TIME_AS_NS(t) / NS_PER_D; }

template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TIME_TO_NS(const IECVar<L_>& t) noexcept { return iec_unwrap(t); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TIME_TO_US(const IECVar<L_>& t) noexcept { return iec_unwrap(t) / NS_PER_US; }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TIME_TO_M(const IECVar<L_>& t) noexcept { return iec_unwrap(t) / NS_PER_M; }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TIME_TO_H(const IECVar<L_>& t) noexcept { return iec_unwrap(t) / NS_PER_H; }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TIME_TO_D(const IECVar<L_>& t) noexcept { return iec_unwrap(t) / NS_PER_D; }

// ---------------------------------------------------------------------------
// Arithmetic: TIME wraps modulo 2^32 ms; LTIME is signed 64-bit ns
// ---------------------------------------------------------------------------
inline IEC_TIME ABS_TIME(IEC_TIME t) noexcept { return t; }
inline IEC_TIME ADD_TIME(IEC_TIME a, IEC_TIME b) noexcept { return IEC_TIME(a.get() + b.get()); }
inline IEC_TIME SUB_TIME(IEC_TIME a, IEC_TIME b) noexcept { return IEC_TIME(a.get() - b.get()); }

template<typename S>
inline IEC_TIME MUL_TIME(IEC_TIME t, S scalar) noexcept {
    return IEC_TIME(t.get() * iec_unwrap(scalar));
}

template<typename S>
inline IEC_TIME DIV_TIME(IEC_TIME t, S scalar) noexcept {
    return IEC_TIME(t.get() / iec_unwrap(scalar));
}

template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTIME ABS_TIME(const IECVar<L_>& t) noexcept {
    const LTIME_t ns = iec_unwrap(t);
    return IEC_LTIME(ns >= 0 ? ns : -ns);
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTIME ADD_LTIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return IEC_LTIME(iec_unwrap(a) + iec_unwrap(b)); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTIME SUB_LTIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return IEC_LTIME(iec_unwrap(a) - iec_unwrap(b)); }
template<typename S, typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTIME MUL_LTIME(const IECVar<L_>& t, S scalar) noexcept {
    return IEC_LTIME(static_cast<LTIME_t>(iec_unwrap(t) * iec_unwrap(scalar)));
}
template<typename S, typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTIME DIV_LTIME(const IECVar<L_>& t, S scalar) noexcept {
    return IEC_LTIME(static_cast<LTIME_t>(iec_unwrap(t) / iec_unwrap(scalar)));
}

// DIVTIME(a, b) returns the integer count of `b`-durations that fit in `a`
// (i.e. `floor(a / b)`); 0 when b is zero (generated code calls iec_divtime,
// which faults on b = 0).
inline int64_t DIVTIME(IEC_TIME a, IEC_TIME b) noexcept {
    return b.get().raw == 0u ? 0 : static_cast<int64_t>(a.get().raw / b.get().raw);
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DIVTIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept {
    return iec_unwrap(b) == 0 ? 0 : iec_unwrap(a) / iec_unwrap(b);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
inline bool GT_TIME(IEC_TIME a, IEC_TIME b) noexcept { return a.get() >  b.get(); }
inline bool GE_TIME(IEC_TIME a, IEC_TIME b) noexcept { return a.get() >= b.get(); }
inline bool EQ_TIME(IEC_TIME a, IEC_TIME b) noexcept { return a.get() == b.get(); }
inline bool NE_TIME(IEC_TIME a, IEC_TIME b) noexcept { return a.get() != b.get(); }
inline bool LE_TIME(IEC_TIME a, IEC_TIME b) noexcept { return a.get() <= b.get(); }
inline bool LT_TIME(IEC_TIME a, IEC_TIME b) noexcept { return a.get() <  b.get(); }

template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GT_TIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >  iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GE_TIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool EQ_TIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) == iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool NE_TIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) != iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LE_TIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LT_TIME(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <  iec_unwrap(b); }

} // namespace strucpp
