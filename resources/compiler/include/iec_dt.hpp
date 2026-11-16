// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC DATE_AND_TIME Standard Functions
 *
 * IEC 61131-3 standard functions on the DATE_AND_TIME (DT) and LDT
 * combined types.  DT / LDT are stored as signed nanoseconds since
 * the Unix epoch (1970-01-01 00:00:00) in `IECVar<DT_t>` — the same
 * generic per-variable wrapper used everywhere.  Codegen emits DT
 * variables as `IEC_DT` (the `IECVar<DT_t>` alias) and the functions
 * below take/return `IEC_DT` so they're directly callable from
 * generated POU code.
 *
 * Scope: only the standard arithmetic / comparison / split-join
 * functions.  Calendar/clock component accessors (DT_YEAR,
 * DT_MONTH, DT_DAY, DT_HOUR, …) are intentionally NOT here — those
 * are OSCAT-style extensions and user libraries (OSCAT, codesys-v23
 * stdlib imports) ship their own implementations.  Providing them
 * here would create overload ambiguity when a project imports such
 * a library.
 *
 * Historical note: an earlier `DateTimeValue<T>` + `IECDtVar<T>`
 * value-class design lived here.  Codegen never adopted it; the
 * parallel API was dead from generated code's perspective.  Removed
 * in favour of a single IECVar-based surface.  See `iec_time.hpp`
 * for the matching note on the TIME family.
 */

#pragma once

#include <cstdint>
#include "iec_types.hpp"
#include "iec_var.hpp"
#include "iec_date.hpp"
#include "iec_tod.hpp"
#include "iec_time.hpp"
#include "iec_traits.hpp"

namespace strucpp {

// DT is 32-bit seconds since 1970-01-01-00:00:00, wrapping modulo 2^32
// (DT#1970-01-01-00:00:00 .. DT#2106-02-07-06:28:15). LDT is signed 64-bit
// nanoseconds since the same instant.
constexpr int64_t DT_NS_PER_DAY = IEC_NS_PER_DAY;

/** Seconds since 1970 as a DT, modulo 2^32. */
inline DT_t DT_OF_SECONDS(int64_t s) noexcept {
    return DT_t(static_cast<uint32_t>(static_cast<uint64_t>(s)));
}

/** A DT as nanoseconds since 1970 (exact). */
inline int64_t DT_AS_NS(DT_t dt) noexcept { return static_cast<int64_t>(dt.raw) * 1000000000LL; }

/** Nanoseconds since 1970 as a DT: floored to the second, modulo 2^32. */
inline DT_t DT_OF_NS(int64_t ns) noexcept {
    return DT_OF_SECONDS(iec_floor_div(ns, 1000000000LL));
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------
inline IEC_DT DT_FROM_COMPONENTS(
    int year, int month, int day,
    int hour, int minute, int second,
    int millisecond = 0, int microsecond = 0, int nanosecond = 0) noexcept {
    const int a = (14 - month) / 12;
    const int y = year + 4800 - a;
    const int m = month + 12 * a - 3;
    const int jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    constexpr int UNIX_EPOCH_JDN = 2440588;
    const int64_t days = jdn - UNIX_EPOCH_JDN;

    const int64_t ns = days * DT_NS_PER_DAY +
                       static_cast<int64_t>(hour) * 3600LL * 1000000000LL +
                       static_cast<int64_t>(minute) * 60LL * 1000000000LL +
                       static_cast<int64_t>(second) * 1000000000LL +
                       static_cast<int64_t>(millisecond) * 1000000LL +
                       static_cast<int64_t>(microsecond) * 1000LL +
                       nanosecond;
    return IEC_DT(DT_OF_NS(ns));
}

inline IEC_DT DT_FROM_NS(int64_t ns) noexcept { return IEC_DT(DT_OF_NS(ns)); }
inline IEC_DT DT_FROM_SECONDS(int64_t s) noexcept { return IEC_DT(DT_OF_SECONDS(s)); }

// IEC 61131-3 `CONCAT_DATE_TOD`: a calendar date and a time of day as one
// DT (whole seconds; the ms of the TOD are dropped).
inline IEC_DT CONCAT_DATE_TOD(IEC_DATE date, IEC_TOD tod) noexcept {
    return IEC_DT(DT_OF_SECONDS(static_cast<int64_t>(date.get().raw) +
                                static_cast<int64_t>(tod.get().raw / 1000u)));
}

// IEC 61131-3 `DT_TO_DATE` and `DT_TO_TOD`: the date and time-of-day parts.
inline IEC_DATE DATE_OF_DT(IEC_DT dt) noexcept {
    const uint32_t s = dt.get().raw;
    return IEC_DATE(DATE_t(s - s % static_cast<uint32_t>(IEC_SECONDS_PER_DAY)));
}
inline IEC_TOD TOD_OF_DT(IEC_DT dt) noexcept {
    return IEC_TOD(TOD_t((dt.get().raw % static_cast<uint32_t>(IEC_SECONDS_PER_DAY)) * 1000u));
}

// The same for LDT (ns, signed): the borrow of a pre-epoch value spills into
// the day, keeping the time of day in [0, 24h).
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LDATE DATE_OF_DT(const IECVar<L_>& dt) noexcept {
    return IEC_LDATE(static_cast<LDATE_t>(iec_floor_div(iec_unwrap(dt), DT_NS_PER_DAY)));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LTOD TOD_OF_DT(const IECVar<L_>& dt) noexcept {
    LDT_t tod_ns = iec_unwrap(dt) % DT_NS_PER_DAY;
    if (tod_ns < 0) tod_ns += DT_NS_PER_DAY;
    return IEC_LTOD(static_cast<LTOD_t>(tod_ns));
}

inline int64_t DT_TO_NS(IEC_DT dt) noexcept { return DT_AS_NS(dt.get()); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DT_TO_NS(const IECVar<L_>& dt) noexcept { return iec_unwrap(dt); }
inline int64_t DT_TO_MS(IEC_DT dt) noexcept { return static_cast<int64_t>(dt.get().raw) * 1000LL; }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DT_TO_MS(const IECVar<L_>& dt) noexcept { return iec_floor_div(iec_unwrap(dt), 1000000LL); }
inline int64_t DT_TO_SECONDS(IEC_DT dt) noexcept { return static_cast<int64_t>(dt.get().raw); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DT_TO_SECONDS(const IECVar<L_>& dt) noexcept { return iec_floor_div(iec_unwrap(dt), 1000000000LL); }

// ---------------------------------------------------------------------------
// Arithmetic (seconds for DT, nanoseconds for LDT)
// ---------------------------------------------------------------------------
inline IEC_DT ADD_DT(IEC_DT dt, int64_t s) noexcept {
    return IEC_DT(DT_OF_SECONDS(static_cast<int64_t>(dt.get().raw) + s));
}
inline IEC_DT SUB_DT(IEC_DT dt, int64_t s) noexcept {
    return IEC_DT(DT_OF_SECONDS(static_cast<int64_t>(dt.get().raw) - s));
}
inline int64_t DIFF_DT(IEC_DT a, IEC_DT b) noexcept {
    return static_cast<int64_t>(a.get().raw) - static_cast<int64_t>(b.get().raw);
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LDT ADD_DT(const IECVar<L_>& dt, int64_t ns) noexcept {
    return IEC_LDT(iec_unwrap(dt) + static_cast<LDT_t>(ns));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline IEC_LDT SUB_DT(const IECVar<L_>& dt, int64_t ns) noexcept {
    return IEC_LDT(iec_unwrap(dt) - static_cast<LDT_t>(ns));
}
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t DIFF_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept {
    return iec_unwrap(a) - iec_unwrap(b);
}

// ---------------------------------------------------------------------------
// + and - on the 32-bit types (Table 30): a TOD, DT or DATE moved by a TIME,
// and the TIME between two of them, each modulo 2^32. A DT or DATE moved by a
// TIME is the second or day that holds the resulting instant.
// ---------------------------------------------------------------------------
namespace detail {
inline TIME_t time_of_ms(int64_t ms) noexcept {
    return TIME_t(static_cast<uint32_t>(static_cast<uint64_t>(ms)));
}
inline TOD_t temporal_add(TOD_t a, TIME_t t) noexcept { return TOD_t(a.raw + t.raw); }
inline TOD_t temporal_add(TIME_t t, TOD_t a) noexcept { return TOD_t(a.raw + t.raw); }
inline DT_t temporal_add(DT_t a, TIME_t t) noexcept { return DT_OF_NS(DT_AS_NS(a) + TIME_AS_NS(t)); }
inline DT_t temporal_add(TIME_t t, DT_t a) noexcept { return temporal_add(a, t); }
inline DATE_t temporal_add(DATE_t d, TIME_t t) noexcept {
    return DATE_OF_DAYS(DATE_AS_DAYS(d) + static_cast<int64_t>(t.raw / 86400000u));
}
inline DATE_t temporal_add(TIME_t t, DATE_t d) noexcept { return temporal_add(d, t); }

inline TOD_t temporal_sub(TOD_t a, TIME_t t) noexcept { return TOD_t(a.raw - t.raw); }
inline DT_t temporal_sub(DT_t a, TIME_t t) noexcept { return DT_OF_NS(DT_AS_NS(a) - TIME_AS_NS(t)); }
inline DATE_t temporal_sub(DATE_t d, TIME_t t) noexcept {
    return DATE_OF_DAYS(iec_floor_div(DATE_AS_DAYS(d) * 86400000LL - static_cast<int64_t>(t.raw),
                                      86400000LL));
}
inline TIME_t temporal_sub(TOD_t a, TOD_t b) noexcept { return TIME_t(a.raw - b.raw); }
inline TIME_t temporal_sub(DT_t a, DT_t b) noexcept {
    return time_of_ms((static_cast<int64_t>(a.raw) - static_cast<int64_t>(b.raw)) * 1000LL);
}
inline TIME_t temporal_sub(DATE_t a, DATE_t b) noexcept {
    return time_of_ms((static_cast<int64_t>(a.raw) - static_cast<int64_t>(b.raw)) * 1000LL);
}
}  // namespace detail

/** ADD_DT, SUB_DT, ADD_TOD and SUB_TOD by a TIME, as `+` and `-` do. */
inline IEC_DT ADD_DT(IEC_DT dt, IEC_TIME t) noexcept { return IEC_DT(detail::temporal_add(dt.get(), t.get())); }
inline IEC_DT SUB_DT(IEC_DT dt, IEC_TIME t) noexcept { return IEC_DT(detail::temporal_sub(dt.get(), t.get())); }
inline IEC_TOD ADD_TOD(IEC_TOD tod, IEC_TIME t) noexcept { return IEC_TOD(detail::temporal_add(tod.get(), t.get())); }
inline IEC_TOD SUB_TOD(IEC_TOD tod, IEC_TIME t) noexcept { return IEC_TOD(detail::temporal_sub(tod.get(), t.get())); }

template<typename A, typename B>
inline auto iec_temporal_add(const A& a, const B& b) noexcept
    -> IECVar<decltype(detail::temporal_add(iec_unwrap(a), iec_unwrap(b)))> {
    return IECVar<decltype(detail::temporal_add(iec_unwrap(a), iec_unwrap(b)))>(
        detail::temporal_add(iec_unwrap(a), iec_unwrap(b)));
}
template<typename A, typename B>
inline auto iec_temporal_sub(const A& a, const B& b) noexcept
    -> IECVar<decltype(detail::temporal_sub(iec_unwrap(a), iec_unwrap(b)))> {
    return IECVar<decltype(detail::temporal_sub(iec_unwrap(a), iec_unwrap(b)))>(
        detail::temporal_sub(iec_unwrap(a), iec_unwrap(b)));
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
inline bool GT_DT(IEC_DT a, IEC_DT b) noexcept { return a.get() >  b.get(); }
inline bool GE_DT(IEC_DT a, IEC_DT b) noexcept { return a.get() >= b.get(); }
inline bool EQ_DT(IEC_DT a, IEC_DT b) noexcept { return a.get() == b.get(); }
inline bool NE_DT(IEC_DT a, IEC_DT b) noexcept { return a.get() != b.get(); }
inline bool LE_DT(IEC_DT a, IEC_DT b) noexcept { return a.get() <= b.get(); }
inline bool LT_DT(IEC_DT a, IEC_DT b) noexcept { return a.get() <  b.get(); }

template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GT_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >  iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool GE_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) >= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool EQ_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) == iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool NE_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) != iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LE_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <= iec_unwrap(b); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline bool LT_DT(const IECVar<L_>& a, const IECVar<L_>& b) noexcept { return iec_unwrap(a) <  iec_unwrap(b); }

} // namespace strucpp
