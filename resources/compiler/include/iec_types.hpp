// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
//
// ============================================================================
// WARNING: KEEP THIS HEADER C++14-CLEAN.
// ----------------------------------------------------------------------------
// strucpp targets C++17 and its EMITTED code is compiled as C++17 — but this
// header is part of the C/C++ Function Block include chain, which is NOT.
// OpenPLC Editor's Arduino flow emits `c_blocks_code.cpp`, including
// `iec_var.hpp` + `iec_string.hpp` (which transitively pull in `iec_traits.hpp`
// and `iec_types.hpp`). That translation unit is compiled under whatever
// `-std=` the Arduino core picks, and every mbed-based core — Nano RP2040
// Connect, Nano 33 BLE, Opta, GIGA, Portenta, Edge — hard-codes `-std=gnu++14`.
// So any C++17/20 construct reachable from here breaks the user's C/C++ POU
// build, even though the rest of strucpp is happily on C++17.
//
// In this header (and anything it includes) do NOT use C++17/20 features
// unguarded. In particular:
//   * `std::trait_v<T>`                -> `std::trait<T>::value`
//   * `if constexpr`                  -> SFINAE / tag dispatch
//   * inline variables / `inline constexpr`
//   * `auto` non-type template params -> typed NTTPs
//   * C++17/20 library headers (<optional>, <variant>, <string_view>,
//     <concepts>, ...) -> include ONLY behind `#if __cplusplus >= ...`
//     (see the guarded <concepts> block further down in this file).
//
// Boundary introduced in commit be85d8a. If you change which headers
// `c_blocks_code.cpp` pulls in, update this set of warnings accordingly.
// ============================================================================
/**
 * STruC++ Runtime - IEC Type Definitions
 *
 * This header defines the C++ type aliases for IEC 61131-3 data types.
 * These types are used by generated code and provide the foundation
 * for the STruC++ runtime library.
 */

#pragma once

#include <cstdint>
#include <cstddef>
#include <cmath>
#include <type_traits>

// <concepts> must be included at file scope: the concept declarations that use
// it live inside `namespace strucpp`, and including a standard header from
// there would nest the whole of `std` under it. Guarded because the runtime
// targets C++14 and only some cores compile the sketch at C++20 or above.
#if __cplusplus >= 202002L
#include <concepts>
#endif

/**
 * STRUCPP_MAY_ALIAS marks a type whose objects may be read and written through
 * a pointer of another type, as IEC 61131-3 POINTER TO allows: a DWORD read as
 * ARRAY OF BYTE, a REAL as a DWORD, a STRUCT as bytes. Without it, GCC and
 * Clang's type-based alias analysis may reorder such accesses at -O2.
 *
 * GCC and Clang only. MSVC does no type-based alias analysis, so nothing is
 * needed there; any other compiler must be run with its equivalent of
 * -fno-strict-aliasing.
 */
#if defined(__GNUC__) || defined(__clang__)
#define STRUCPP_MAY_ALIAS __attribute__((__may_alias__))
#else
#define STRUCPP_MAY_ALIAS
#endif

namespace strucpp {

// =============================================================================
// Elementary Types - Bit Strings
// =============================================================================

/** IEC BOOL - Boolean value (TRUE/FALSE) */
using BOOL_t = bool;

/** IEC BYTE - 8-bit bit string */
using BYTE_t = uint8_t;

/** IEC WORD - 16-bit bit string */
using WORD_t = uint16_t;

/** IEC DWORD - 32-bit bit string */
using DWORD_t = uint32_t;

/** IEC LWORD - 64-bit bit string (IEC v3) */
using LWORD_t = uint64_t;

/**
 * CODESYS __XWORD - unsigned integer sized to the target pointer width.
 * Used for ADR()/REF() results and generic pointer-sized values, so an
 * address round-trips without truncation and without wasting space on
 * narrow targets (2 bytes on AVR, 8 on 64-bit hosts). `__SIZEOF_POINTER__`
 * is provided by GCC/Clang/avr-gcc.
 */
#if __SIZEOF_POINTER__ <= 2
using XWORD_t = uint16_t;
#elif __SIZEOF_POINTER__ <= 4
using XWORD_t = uint32_t;
#else
using XWORD_t = uint64_t;
#endif

// =============================================================================
// Elementary Types - Signed Integers
// =============================================================================

/** IEC SINT - Short integer (8-bit signed) */
using SINT_t = int8_t;

/** IEC INT - Integer (16-bit signed) */
using INT_t = int16_t;

/** IEC DINT - Double integer (32-bit signed) */
using DINT_t = int32_t;

/** IEC LINT - Long integer (64-bit signed) */
using LINT_t = int64_t;

// =============================================================================
// Elementary Types - Unsigned Integers
// =============================================================================

/** IEC USINT - Unsigned short integer (8-bit) */
using USINT_t = uint8_t;

/** IEC UINT - Unsigned integer (16-bit) */
using UINT_t = uint16_t;

/** IEC UDINT - Unsigned double integer (32-bit) */
using UDINT_t = uint32_t;

/** IEC ULINT - Unsigned long integer (64-bit) */
using ULINT_t = uint64_t;

// =============================================================================
// Elementary Types - Real Numbers
// =============================================================================

/** IEC REAL - Single precision floating point (32-bit IEEE 754) */
using REAL_t = float;

/** IEC LREAL - Double precision floating point (64-bit IEEE 754) */
using LREAL_t = double;

// =============================================================================
// Elementary Types - Time and Date
// =============================================================================

/**
 * One day, in the two units the temporal types are exchanged in.
 *
 * Defined here because iec_date, iec_dt and iec_tod all include this header
 * and had a private copy each. They are only ever the same number, and since
 * the conversion helpers now convert BETWEEN those types, a divergence would
 * produce wrong values rather than merely duplicated text.
 */
constexpr int64_t IEC_SECONDS_PER_DAY = 24LL * 60LL * 60LL;
constexpr int64_t IEC_NS_PER_DAY = IEC_SECONDS_PER_DAY * 1000000000LL;

/**
 * The 32-bit TIME (ms), DATE (s since 1970-01-01, whole days), TIME_OF_DAY (ms
 * since midnight) and DATE_AND_TIME (s since 1970-01-01): one distinct type
 * per kind, unsigned, wrapping modulo 2^32, 4 bytes as on the PLC. A raw count
 * in the kind's unit converts in only explicitly.
 */
template<int Kind>
struct STRUCPP_MAY_ALIAS IecTemporal32 {
    uint32_t raw;
    constexpr IecTemporal32() noexcept : raw(0) {}
    explicit constexpr IecTemporal32(uint32_t r) noexcept : raw(r) {}
    /** The raw count in the kind's unit. */
    explicit constexpr operator uint32_t() const noexcept { return raw; }
};

/** Kinds of IecTemporal32. */
constexpr int IEC_KIND_TIME = 0;
constexpr int IEC_KIND_DATE = 1;
constexpr int IEC_KIND_TOD = 2;
constexpr int IEC_KIND_DT = 3;

/** IEC TIME - Duration in milliseconds, 0 .. T#49d17h2m47s295ms */
using TIME_t = IecTemporal32<IEC_KIND_TIME>;

/** IEC DATE - Seconds since 1970-01-01, a whole number of days */
using DATE_t = IecTemporal32<IEC_KIND_DATE>;

/** IEC TIME_OF_DAY - Milliseconds since midnight */
using TOD_t = IecTemporal32<IEC_KIND_TOD>;

/** IEC DATE_AND_TIME - Seconds since 1970-01-01-00:00:00 */
using DT_t = IecTemporal32<IEC_KIND_DT>;

template<int K>
constexpr IecTemporal32<K> operator+(IecTemporal32<K> a, IecTemporal32<K> b) noexcept {
    return IecTemporal32<K>(static_cast<uint32_t>(a.raw + b.raw));
}
template<int K>
constexpr IecTemporal32<K> operator-(IecTemporal32<K> a, IecTemporal32<K> b) noexcept {
    return IecTemporal32<K>(static_cast<uint32_t>(a.raw - b.raw));
}
template<int K>
constexpr IecTemporal32<K> operator-(IecTemporal32<K> a) noexcept {
    return IecTemporal32<K>(static_cast<uint32_t>(0u - a.raw));
}
template<int K>
constexpr IecTemporal32<K> operator+(IecTemporal32<K> a) noexcept { return a; }

namespace detail {
/** `raw * n` modulo 2^32: an integer exactly, a REAL truncated toward zero. */
template<typename N, std::enable_if_t<std::is_integral<N>::value, int> = 0>
inline uint32_t temporal_scale(uint32_t raw, N n) noexcept {
    return static_cast<uint32_t>(static_cast<uint64_t>(raw) * static_cast<uint64_t>(n));
}
/** A REAL result in the temporal unit: truncated toward zero, modulo 2^32 (not finite: 0). */
inline uint32_t temporal_from_double(double v) noexcept {
    if (!std::isfinite(v)) return 0u;
    const double t = v < 0 ? -std::floor(-v) : std::floor(v);
    const double m = std::fmod(t, 4294967296.0);
    return static_cast<uint32_t>(static_cast<int64_t>(m < 0 ? m + 4294967296.0 : m));
}
template<typename N, std::enable_if_t<std::is_floating_point<N>::value, int> = 0>
inline uint32_t temporal_scale(uint32_t raw, N n) noexcept {
    return temporal_from_double(static_cast<double>(raw) * static_cast<double>(n));
}
/** `raw / n`, truncated toward zero, modulo 2^32; by 0 it is 0. */
template<typename N, std::enable_if_t<std::is_integral<N>::value && std::is_signed<N>::value, int> = 0>
inline uint32_t temporal_divide(uint32_t raw, N n) noexcept {
    if (n == 0) return 0u;
    const int64_t v = static_cast<int64_t>(n);
    const uint64_t mag = v < 0 ? 0u - static_cast<uint64_t>(v) : static_cast<uint64_t>(v);
    const uint32_t q = static_cast<uint32_t>(static_cast<uint64_t>(raw) / mag);
    return v < 0 ? static_cast<uint32_t>(0u - q) : q;
}
template<typename N, std::enable_if_t<std::is_integral<N>::value && !std::is_signed<N>::value, int> = 0>
inline uint32_t temporal_divide(uint32_t raw, N n) noexcept {
    if (n == 0) return 0u;
    return static_cast<uint32_t>(static_cast<uint64_t>(raw) / static_cast<uint64_t>(n));
}
template<typename N, std::enable_if_t<std::is_floating_point<N>::value, int> = 0>
inline uint32_t temporal_divide(uint32_t raw, N n) noexcept {
    if (n == 0) return 0u;
    return temporal_from_double(static_cast<double>(raw) / static_cast<double>(n));
}
/** `raw MOD n`: the remainder by the divisor's magnitude; by 0 it is 0. */
template<typename N, std::enable_if_t<std::is_integral<N>::value, int> = 0>
inline uint32_t temporal_modulo(uint32_t raw, N n) noexcept {
    if (n == 0) return 0u;
    const uint64_t mag = std::is_signed<N>::value && static_cast<int64_t>(n) < 0
        ? 0u - static_cast<uint64_t>(static_cast<int64_t>(n))
        : static_cast<uint64_t>(n);
    return static_cast<uint32_t>(static_cast<uint64_t>(raw) % mag);
}
}  // namespace detail

template<int K, typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
inline IecTemporal32<K> operator*(IecTemporal32<K> a, N n) noexcept {
    return IecTemporal32<K>(detail::temporal_scale(a.raw, n));
}
template<int K, typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
inline IecTemporal32<K> operator*(N n, IecTemporal32<K> a) noexcept {
    return IecTemporal32<K>(detail::temporal_scale(a.raw, n));
}
template<int K, typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
inline IecTemporal32<K> operator/(IecTemporal32<K> a, N n) noexcept {
    return IecTemporal32<K>(detail::temporal_divide(a.raw, n));
}

/** A duration by a duration (TIME / TIME): the integer quotient of the raw values; by 0 it is 0. */
template<int K>
inline IecTemporal32<K> operator/(IecTemporal32<K> a, IecTemporal32<K> b) noexcept {
    return IecTemporal32<K>(b.raw == 0u ? 0u : a.raw / b.raw);
}
template<int K, typename N, std::enable_if_t<std::is_integral<N>::value, int> = 0>
inline IecTemporal32<K> operator%(IecTemporal32<K> a, N n) noexcept {
    return IecTemporal32<K>(detail::temporal_modulo(a.raw, n));
}
template<int K>
inline IecTemporal32<K> operator%(IecTemporal32<K> a, IecTemporal32<K> b) noexcept {
    return IecTemporal32<K>(detail::temporal_modulo(a.raw, b.raw));
}

/** A TOD MOD a TIME (both ms): the time within that period; MOD T#0s gives 0. */
inline IecTemporal32<IEC_KIND_TOD> iec_mod_period(IecTemporal32<IEC_KIND_TOD> a, IecTemporal32<IEC_KIND_TIME> p) noexcept {
    return IecTemporal32<IEC_KIND_TOD>(detail::temporal_modulo(a.raw, p.raw));
}
/** A DT (s) MOD a TIME (ms): the remainder in ms, truncated to whole seconds; MOD T#0s gives 0. */
inline IecTemporal32<IEC_KIND_DT> iec_mod_period(IecTemporal32<IEC_KIND_DT> a, IecTemporal32<IEC_KIND_TIME> p) noexcept {
    return IecTemporal32<IEC_KIND_DT>(p.raw == 0u ? 0u : static_cast<uint32_t>(static_cast<uint64_t>(a.raw) * 1000u % p.raw / 1000u));
}

template<int K> constexpr bool operator==(IecTemporal32<K> a, IecTemporal32<K> b) noexcept { return a.raw == b.raw; }
template<int K> constexpr bool operator!=(IecTemporal32<K> a, IecTemporal32<K> b) noexcept { return a.raw != b.raw; }
template<int K> constexpr bool operator<(IecTemporal32<K> a, IecTemporal32<K> b) noexcept { return a.raw < b.raw; }
template<int K> constexpr bool operator>(IecTemporal32<K> a, IecTemporal32<K> b) noexcept { return a.raw > b.raw; }
template<int K> constexpr bool operator<=(IecTemporal32<K> a, IecTemporal32<K> b) noexcept { return a.raw <= b.raw; }
template<int K> constexpr bool operator>=(IecTemporal32<K> a, IecTemporal32<K> b) noexcept { return a.raw >= b.raw; }

/**
 * A 32-bit value in the unit of its long form (Ed. 3), for the implicit
 * TIME -> LTIME, TOD -> LTOD, DT -> LDT (ns) and DATE -> LDATE (days).
 */
constexpr int64_t iec_long_value(IecTemporal32<IEC_KIND_TIME> v) noexcept {
    return static_cast<int64_t>(v.raw) * 1000000LL;
}
constexpr int64_t iec_long_value(IecTemporal32<IEC_KIND_TOD> v) noexcept {
    return static_cast<int64_t>(v.raw) * 1000000LL;
}
constexpr int64_t iec_long_value(IecTemporal32<IEC_KIND_DT> v) noexcept {
    return static_cast<int64_t>(v.raw) * 1000000000LL;
}
constexpr int64_t iec_long_value(IecTemporal32<IEC_KIND_DATE> v) noexcept {
    return static_cast<int64_t>(v.raw / 86400u);
}

/** A 32-bit temporal value written to a stream: its raw count (ms or s). */
template<typename OS, int K>
inline auto operator<<(OS& os, const IecTemporal32<K>& v) -> decltype(os << v.raw) {
    return os << v.raw;
}

/** A 32-bit temporal type (IecTemporal32). */
template<typename T> struct is_temporal32 : std::false_type {};
template<int K> struct is_temporal32<IecTemporal32<K>> : std::true_type {};

// IEC v3 Long variants (extended precision/range)

/** IEC LTIME - Long duration in nanoseconds (IEC v3) */
using LTIME_t = int64_t;

/** IEC LDATE - Long calendar date (days since epoch, IEC v3) */
using LDATE_t = int64_t;

/** IEC LTOD - Long time of day in nanoseconds since midnight (IEC v3) */
using LTOD_t = int64_t;

/** IEC LDT - Long combined date and time (IEC v3) */
using LDT_t = int64_t;

// =============================================================================
// Platform Pointer-Width Integer
// =============================================================================

/** Platform-width integer for pointer-to-integer conversions (CODESYS compat).
 *  On 64-bit platforms this is uint64_t; on 32-bit platforms uint32_t.
 *  Use this instead of DWORD for storing pointer addresses portably. */
#if UINTPTR_MAX > UINT32_MAX
using PTR_INT_t = uint64_t;
#else
using PTR_INT_t = uint32_t;
#endif

// =============================================================================
// Elementary Types - Characters
// =============================================================================

/** IEC CHAR - Single-byte character */
using CHAR_t = char;

/** IEC WCHAR - Wide character (UTF-16) */
using WCHAR_t = char16_t;

// =============================================================================
// Type Category Tags
// =============================================================================

/** Tag for ANY_BIT types */
struct AnyBitTag {};

/** Tag for ANY_INT types */
struct AnyIntTag {};

/** Tag for ANY_REAL types */
struct AnyRealTag {};

/** Tag for ANY_NUM types (ANY_INT | ANY_REAL) */
struct AnyNumTag {};

/** Tag for ANY_DATE types */
struct AnyDateTag {};

/** Tag for ANY_STRING types */
struct AnyStringTag {};

// =============================================================================
// Type Traits
// =============================================================================

/**
 * Type trait to get the category tag for an IEC type.
 */
template<typename T>
struct IECTypeCategory;

// Note: Some IEC types share the same underlying C++ type, so we only define
// one specialization per unique C++ type. The type category is determined by
// the primary use case of that underlying type.

// Boolean type
template<> struct IECTypeCategory<bool> { using type = AnyBitTag; };

// 8-bit types (BYTE_t/USINT_t are both uint8_t, SINT_t is int8_t)
template<> struct IECTypeCategory<uint8_t> { using type = AnyBitTag; };
template<> struct IECTypeCategory<int8_t> { using type = AnyIntTag; };

// 16-bit types (WORD_t/UINT_t are both uint16_t, INT_t is int16_t)
template<> struct IECTypeCategory<uint16_t> { using type = AnyBitTag; };
template<> struct IECTypeCategory<int16_t> { using type = AnyIntTag; };

// 32-bit types (DWORD_t/UDINT_t are both uint32_t, DINT_t is int32_t)
template<> struct IECTypeCategory<uint32_t> { using type = AnyBitTag; };
template<> struct IECTypeCategory<int32_t> { using type = AnyIntTag; };

// 64-bit types (LWORD_t/ULINT_t are both uint64_t)
// Note: LINT_t, LTIME_t, LDATE_t, LTOD_t, LDT_t are all int64_t
template<> struct IECTypeCategory<uint64_t> { using type = AnyBitTag; };
template<> struct IECTypeCategory<int64_t> { using type = AnyIntTag; };

// Real types
template<> struct IECTypeCategory<float> { using type = AnyRealTag; };
template<> struct IECTypeCategory<double> { using type = AnyRealTag; };

// The 32-bit date and time types
template<int K> struct IECTypeCategory<IecTemporal32<K>> { using type = AnyDateTag; };

// Character types
template<> struct IECTypeCategory<char> { using type = AnyStringTag; };
template<> struct IECTypeCategory<char16_t> { using type = AnyStringTag; };

// =============================================================================
// C++20 Concepts (when available)
// =============================================================================

#if __cplusplus >= 202002L

/** Concept for ANY_BIT types */
template<typename T>
concept IECAnyBit = std::is_same<typename IECTypeCategory<T>::type, AnyBitTag>::value;

/** Concept for ANY_INT types */
template<typename T>
concept IECAnyInt = std::is_same<typename IECTypeCategory<T>::type, AnyIntTag>::value;

/** Concept for ANY_REAL types */
template<typename T>
concept IECAnyReal = std::is_same<typename IECTypeCategory<T>::type, AnyRealTag>::value;

/** Concept for ANY_NUM types */
template<typename T>
concept IECAnyNum = IECAnyInt<T> || IECAnyReal<T>;

/** Concept for ANY_DATE types */
template<typename T>
concept IECAnyDate = std::is_same<typename IECTypeCategory<T>::type, AnyDateTag>::value;

#endif // C++20

} // namespace strucpp
