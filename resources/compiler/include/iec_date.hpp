// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC DATE Standard Functions
 *
 * IEC 61131-3 standard functions on the DATE (and LDATE) calendar
 * types.  DATE / LDATE are stored as signed days since the Unix epoch
 * (1970-01-01) in `IECVar<DATE_t>` — the same generic per-variable
 * wrapper used for every other elementary type.  Codegen emits DATE
 * variables as `IEC_DATE` (the `IECVar<DATE_t>` alias) and the
 * functions below take/return `IEC_DATE` so they're directly callable
 * from generated POU code.
 *
 * Scope: only the standard arithmetic / comparison / round-trip
 * functions.  Calendar component accessors (YEAR, MONTH, DAY,
 * DAY_OF_WEEK, DAY_OF_YEAR, …) are intentionally NOT here — those are
 * OSCAT-style extensions and user libraries (OSCAT, codesys-v23
 * stdlib imports, …) ship their own implementations.  Providing them
 * here would create overload ambiguity when a project imports such a
 * library.
 *
 * Historical note: an earlier `DateValue<T>` + `IECDateVar<T>` value-
 * class design lived here.  Codegen never adopted it (DATE variables
 * were always declared as `IEC_DATE`), so the parallel API was dead
 * from generated code's perspective.  Removed in favour of a single
 * IECVar-based surface.  See `iec_time.hpp` for the matching note on
 * the TIME family.
 */

#pragma once

#include <cstdint>
#include "iec_types.hpp"
#include "iec_var.hpp"
#include "iec_traits.hpp"

namespace strucpp {

// DATE is 32-bit seconds since 1970-01-01, a whole number of days, wrapping
// modulo 2^32 (D#1970-01-01 .. D#2106-02-07). LDATE is a signed 64-bit count
// of days. CODESYS-style conversions give DATE in seconds and LDATE in ns.

/**
 * Floor division, so a pre-epoch input borrows a day instead of rounding
 * toward zero.
 */
inline constexpr int64_t iec_floor_div(int64_t n, int64_t d) noexcept {
    const int64_t q = n / d;
    return (n % d != 0 && ((n < 0) != (d < 0))) ? q - 1 : q;
}

constexpr int64_t DATE_SECONDS_PER_DAY = IEC_SECONDS_PER_DAY;
constexpr int64_t DATE_NS_PER_DAY = IEC_NS_PER_DAY;

/** A count of days since 1970-01-01 as a DATE, modulo 2^32 seconds. */
inline DATE_t DATE_OF_DAYS(int64_t days) noexcept {
    return DATE_t(static_cast<uint32_t>(static_cast<uint64_t>(days) *
                                        static_cast<uint64_t>(DATE_SECONDS_PER_DAY)));
}

/** A DATE as days since 1970-01-01. */
inline int64_t DATE_AS_DAYS(DATE_t d) noexcept {
    return static_cast<int64_t>(d.raw / static_cast<uint32_t>(DATE_SECONDS_PER_DAY));
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------
// `DATE_FROM_YMD(2024, 3, 15)` converts a Gregorian (year, month, day)
// triple into a DATE by way of the Julian Day Number.
inline IEC_DATE DATE_FROM_YMD(int year, int month, int day) noexcept {
    const int a = (14 - month) / 12;
    const int y = year + 4800 - a;
    const int m = month + 12 * a - 3;
    const int jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    constexpr int UNIX_EPOCH_JDN = 2440588;
    return IEC_DATE(DATE_OF_DAYS(jdn - UNIX_EPOCH_JDN));
}

inline IEC_DATE DATE_FROM_DAYS(int64_t days) noexcept {
    return IEC_DATE(DATE_OF_DAYS(days));
}

inline int64_t DATE_TO_DAYS(IEC_DATE d) noexcept { return DATE_AS_DAYS(d.get()); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DATE_TO_DAYS(const IECVar<L_>& d) noexcept { return iec_unwrap(d); }

/** DATE as seconds since 1970 (its raw value). */
inline int64_t DATE_TO_SECONDS(IEC_DATE d) noexcept { return static_cast<int64_t>(d.get().raw); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DATE_TO_SECONDS(const IECVar<L_>& d) noexcept { return iec_unwrap(d) * DATE_SECONDS_PER_DAY; }

/** Seconds since 1970 as a DATE: modulo 2^32, then down to its day (as DATE_OF_DT does). */
inline IEC_DATE DATE_FROM_SECONDS(int64_t s) noexcept {
    const uint32_t raw = static_cast<uint32_t>(static_cast<uint64_t>(s));
    return IEC_DATE(DATE_t(raw - raw % static_cast<uint32_t>(DATE_SECONDS_PER_DAY)));
}

inline int64_t DATE_TO_NS(IEC_DATE d) noexcept { return DATE_AS_DAYS(d.get()) * DATE_NS_PER_DAY; }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DATE_TO_NS(const IECVar<L_>& d) noexcept { return iec_unwrap(d) * DATE_NS_PER_DAY; }

/** Nanoseconds since 1970 as an LDATE (days), floored to the day. */
inline IEC_LDATE DATE_FROM_NS(int64_t ns) noexcept {
    return IEC_LDATE(static_cast<LDATE_t>(iec_floor_div(ns, DATE_NS_PER_DAY)));
}

// ---------------------------------------------------------------------------
// Arithmetic (days)
// ---------------------------------------------------------------------------
inline IEC_DATE ADD_DATE(IEC_DATE d, int64_t days) noexcept {
    return IEC_DATE(DATE_OF_DAYS(DATE_AS_DAYS(d.get()) + days));
}
inline IEC_DATE SUB_DATE(IEC_DATE d, int64_t days) noexcept {
    return IEC_DATE(DATE_OF_DAYS(DATE_AS_DAYS(d.get()) - days));
}
inline int64_t DIFF_DATE(IEC_DATE a, IEC_DATE b) noexcept {
    return DATE_AS_DAYS(a.get()) - DATE_AS_DAYS(b.get());
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LDATE ADD_DATE(const IECVar<L_>& d, int64_t days) noexcept {
    return IEC_LDATE(iec_unwrap(d) + static_cast<LDATE_t>(days));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LDATE SUB_DATE(const IECVar<L_>& d, int64_t days) noexcept {
    return IEC_LDATE(iec_unwrap(d) - static_cast<LDATE_t>(days));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DIFF_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept {
    return iec_unwrap(a) - iec_unwrap(b);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
inline bool GT_DATE(IEC_DATE a, IEC_DATE b) noexcept { return a.get() >  b.get(); }
inline bool GE_DATE(IEC_DATE a, IEC_DATE b) noexcept { return a.get() >= b.get(); }
inline bool EQ_DATE(IEC_DATE a, IEC_DATE b) noexcept { return a.get() == b.get(); }
inline bool NE_DATE(IEC_DATE a, IEC_DATE b) noexcept { return a.get() != b.get(); }
inline bool LE_DATE(IEC_DATE a, IEC_DATE b) noexcept { return a.get() <= b.get(); }
inline bool LT_DATE(IEC_DATE a, IEC_DATE b) noexcept { return a.get() <  b.get(); }

template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GT_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >  iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GE_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool EQ_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) == iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool NE_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) != iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LE_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LT_DATE(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <  iec_unwrap(b); }

} // namespace strucpp
