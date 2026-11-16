// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Standard Library
 *
 * This header provides the standard IEC 61131-3 functions and utilities.
 * Functions are implemented as C++ templates with IEC type constraints
 * for type safety and compliance with IEC 61131-3 type system.
 *
 * Type constraints follow IEC 61131-3 ANY type hierarchy:
 * - ANY_NUM: Numeric types (integers + reals)
 * - ANY_INT: Integer types (signed + unsigned)
 * - ANY_REAL: Floating point types (REAL, LREAL)
 * - ANY_BIT: Bit string types (BOOL, BYTE, WORD, DWORD, LWORD)
 * - ANY_ELEMENTARY: All elementary types
 * - ANY_MAGNITUDE: Numeric + time types
 */

#pragma once

#include <limits>
#include "iec_var.hpp"
#include "iec_traits.hpp"
#include "iec_retain.hpp"
#include "iec_ptr.hpp"
#include "iec_enum.hpp"
#include "iec_string.hpp"
#include "iec_wstring.hpp"
// IEC 61131-3 temporal types — pulled in here so the standard
// library entry point exposes every standard function (`ADD_TIME`,
// `ADD_DATE`, `ADD_DT`, `ADD_TOD`, `CONCAT_DATE_TOD`, etc.) without
// the caller having to chase the right per-type header.  `codegen.ts`
// emits a single `#include "iec_std_lib.hpp"` into every
// generated.hpp, so the only way a generated POU using TIME or
// calendar arithmetic can resolve those symbols is through this
// transitive chain.  Header guards make each include idempotent.
#include "iec_time.hpp"
#include "iec_date.hpp"
#include "iec_dt.hpp"
#include "iec_tod.hpp"
#include <cmath>
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <type_traits>
#include <new>

// Undefine AVR `<time.h>` macros that collide with common IEC
// identifiers.  `<chrono>` above pulls in `<ctime>` → `<time.h>`,
// and AVR-libc's `time.h` defines a handful of all-caps duration /
// epoch constants that would silently rewrite a user's similarly-
// named variable into a numeric literal before the C++ parser sees
// it.  The collisions surface as cryptic `expected unqualified-id
// before numeric constant` errors on lines like
// `IEC_TIME ONE_HOUR;`.
//
// Same pattern as the `#undef OVERFLOW` codegen emits into every
// `generated.hpp` to neutralise `<math.h>`'s SVID error code.
// Header guards make each include idempotent, so doing the undef
// right after the time-family includes is fine: any later include
// of `<time.h>` directly would re-define the macros, but no
// strucpp-side header does that.
#undef ONE_HOUR
#undef ONE_DEGREE
#undef ONE_DAY
#undef UNIX_OFFSET
#undef NTP_OFFSET

namespace strucpp {

// =============================================================================
// Base Classes for Runtime
// =============================================================================

// Forward-declared for the two RESERVED vtable slots below. The type no longer
// exists as a definition anywhere — retained leaves are listed project-wide in
// generated_debug.cpp's `retain_vars[]` (see iec_retain.hpp) — but the
// declaration has to stay so the slots keep their signatures and positions.
struct RetainVarInfo;

/**
 * Base class for all program instances.
 * Provides the interface for the runtime scheduler.
 */
struct ProgramBase {
    virtual ~ProgramBase() = default;

    /** Execute one cycle of the program */
    virtual void run() = 0;

    // RESERVED vtable slots 2 and 3, formerly the per-program retain
    // descriptor table. Retained leaves now live in one project-wide
    // `retain_vars[]` addressed by debug-table (arr, elem) — see
    // iec_retain.hpp for why offsets could not work — so generated code no
    // longer overrides these and nothing calls them.
    //
    // They are KEPT, not deleted. The OpenPLC v4 runtime mirrors this vtable
    // by position (core/src/lib/strucpp_abi.hpp) to dispatch run() across a
    // .so boundary; removing a slot would shift every slot after it and
    // mis-dispatch run() for any program built against a different version.
    // Same reasoning as the dead sync_in / sync_out slots below.
    virtual const RetainVarInfo* getRetainVars() const { return nullptr; }
    virtual size_t getRetainCount() const { return 0; }

    // -------------------------------------------------------------------------
    // Threaded-runtime hooks (appended at the end of the vtable so run() stays
    // at slot 1 -- a runtime that predates these still works, it just never
    // calls them). No-ops by default; generated code overrides them ONLY when
    // compiled with STRUCPP_THREADED. The OpenPLC threaded runtime calls
    // sync_in() before run() and sync_out() after, around a per-task private
    // working copy of this program's VAR_EXTERNAL globals (so task bodies run
    // without holding a global lock). located_range() reports this program's
    // contiguous slice of the global locatedVars[] table so the runtime can
    // copy its located I/O in/out scoped to the owning task.
    // -------------------------------------------------------------------------

    /** Copy this program's VAR_EXTERNAL globals from canonical storage into
     *  its private working copies. Called by the runtime before run(). */
    virtual void sync_in() {}

    /** Commit this program's changed VAR_EXTERNAL globals from its working
     *  copies back to canonical storage. Called by the runtime after run(). */
    virtual void sync_out() {}

    /** Report this program's slice [offset, offset+count) of the project-wide
     *  locatedVars[] table. count == 0 means the program has no located I/O. */
    virtual void located_range(uint32_t* offset, uint32_t* count) const {
        *offset = 0;
        *count = 0;
    }
};

/**
 * Task instance descriptor.
 * Describes a task's scheduling properties and associated program instances.
 */
struct TaskInstance {
    const char* name;           ///< Task name
    int64_t interval_ns;        ///< Execution interval in nanoseconds (0 = event-driven)
    int32_t priority;           ///< Task priority (higher = more important)
    ProgramBase** programs;     ///< Array of program instances for this task
    size_t program_count;       ///< Number of programs in this task

    TaskInstance() noexcept
        : name(nullptr), interval_ns(0), priority(0), programs(nullptr), program_count(0) {}

    TaskInstance(const char* n, int64_t interval, int32_t prio,
                 ProgramBase** progs, size_t count) noexcept
        : name(n), interval_ns(interval), priority(prio), programs(progs), program_count(count) {}
};

/**
 * Resource instance descriptor.
 * Describes a resource (processor) and its associated tasks.
 */
struct ResourceInstance {
    const char* name;           ///< Resource name
    const char* processor;      ///< Processor type (from ON clause)
    TaskInstance* tasks;        ///< Array of tasks in this resource
    size_t task_count;          ///< Number of tasks

    ResourceInstance() noexcept
        : name(nullptr), processor(nullptr), tasks(nullptr), task_count(0) {}

    ResourceInstance(const char* n, const char* proc,
                     TaskInstance* t, size_t count) noexcept
        : name(n), processor(proc), tasks(t), task_count(count) {}
};

/**
 * Base class for configuration instances.
 * Provides the interface for the runtime to access project structure.
 */
struct ConfigurationInstance {
    virtual ~ConfigurationInstance() = default;

    /** Get configuration name */
    virtual const char* get_name() const = 0;

    /** Get array of resources */
    virtual ResourceInstance* get_resources() = 0;

    /** Get number of resources */
    virtual size_t get_resource_count() const = 0;
};

// =============================================================================
// Numeric Functions (ANY_NUM -> ANY_NUM, or ANY_REAL -> ANY_REAL)
// =============================================================================

/**
 * ABS - Absolute value
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 */
namespace detail {
// Tag dispatch instead of `if constexpr`: the runtime is C++14 (see the header
// banner). Each overload is the branch that C++17 would have discarded.
template<typename T, typename V>
inline T iec_abs_impl(T value, V v, std::true_type /*floating*/, std::false_type) noexcept {
    (void)value;
    return T(std::abs(v));
}
template<typename T, typename V>
inline T iec_abs_impl(T value, V v, std::false_type, std::true_type /*signed*/) noexcept {
    (void)value;
    return T(v < 0 ? -v : v);
}
template<typename T, typename V>
inline T iec_abs_impl(T value, V, std::false_type, std::false_type /*unsigned*/) noexcept {
    return value;
}
}  // namespace detail

template<typename T, enable_if_any_num<T> = 0>
inline T ABS(T value) noexcept {
    auto v = iec_unwrap(value);
    using V = decltype(v);
    return detail::iec_abs_impl(
        value, v,
        std::integral_constant<bool, std::is_floating_point<V>::value>{},
        std::integral_constant<bool, !std::is_floating_point<V>::value && std::is_signed<V>::value>{});
}

/**
 * SQRT - Square root
 * Input: ANY_REAL, Output: ANY_REAL (same type)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T SQRT(T value) noexcept {
    return T(std::sqrt(static_cast<double>(iec_unwrap(value))));
}

/**
 * LN - Natural logarithm
 * Input: ANY_REAL, Output: ANY_REAL (same type)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T LN(T value) noexcept {
    return T(std::log(static_cast<double>(iec_unwrap(value))));
}

/**
 * LOG - Base-10 logarithm
 * Input: ANY_REAL, Output: ANY_REAL (same type)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T LOG(T value) noexcept {
    return T(std::log10(static_cast<double>(iec_unwrap(value))));
}

/**
 * EXP - Exponential (e^x)
 * Input: ANY_REAL, Output: ANY_REAL (same type)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T EXP(T value) noexcept {
    return T(std::exp(static_cast<double>(iec_unwrap(value))));
}

/**
 * EXPT - Exponentiation (base^exponent)
 * Input: ANY_REAL, Output: ANY_REAL (same type)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T EXPT(T base, T exponent) noexcept {
    return T(std::pow(static_cast<double>(iec_unwrap(base)), static_cast<double>(iec_unwrap(exponent))));
}

// Mixed-type EXPT: allows e.g. EXPT(INT, REAL) → returns LREAL
template<typename T1, typename T2,
         typename = std::enable_if_t<!std::is_same<std::decay_t<T1>, std::decay_t<T2>>::value>>
inline IEC_LREAL EXPT(T1 base, T2 exponent) noexcept {
    return IEC_LREAL(std::pow(static_cast<double>(iec_unwrap(base)), static_cast<double>(iec_unwrap(exponent))));
}

// Same-type EXPT for non-REAL types (CODESYS extension: EXPT(INT, INT))
template<typename T,
    std::enable_if_t<(is_any_int_v<T> || is_any_bit_v<T>) && !is_any_real_v<T>, int> = 0>
inline IEC_LREAL EXPT(T base, T exponent) noexcept {
    return IEC_LREAL(std::pow(static_cast<double>(iec_unwrap(base)), static_cast<double>(iec_unwrap(exponent))));
}

// =============================================================================
// Trigonometric Functions (ANY_REAL -> ANY_REAL)
// =============================================================================

/**
 * SIN - Sine
 * Input: ANY_REAL (radians), Output: ANY_REAL
 */
template<typename T, enable_if_any_real<T> = 0>
inline T SIN(T value) noexcept {
    return T(std::sin(static_cast<double>(iec_unwrap(value))));
}

/**
 * COS - Cosine
 * Input: ANY_REAL (radians), Output: ANY_REAL
 */
template<typename T, enable_if_any_real<T> = 0>
inline T COS(T value) noexcept {
    return T(std::cos(static_cast<double>(iec_unwrap(value))));
}

/**
 * TAN - Tangent
 * Input: ANY_REAL (radians), Output: ANY_REAL
 */
template<typename T, enable_if_any_real<T> = 0>
inline T TAN(T value) noexcept {
    return T(std::tan(static_cast<double>(iec_unwrap(value))));
}

/**
 * ASIN - Arc sine
 * Input: ANY_REAL, Output: ANY_REAL (radians)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T ASIN(T value) noexcept {
    return T(std::asin(static_cast<double>(iec_unwrap(value))));
}

/**
 * ACOS - Arc cosine
 * Input: ANY_REAL, Output: ANY_REAL (radians)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T ACOS(T value) noexcept {
    return T(std::acos(static_cast<double>(iec_unwrap(value))));
}

/**
 * ATAN - Arc tangent
 * Input: ANY_REAL, Output: ANY_REAL (radians)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T ATAN(T value) noexcept {
    return T(std::atan(static_cast<double>(iec_unwrap(value))));
}

/**
 * ATAN2 - Arc tangent of y/x (two-argument form)
 * Input: ANY_REAL, Output: ANY_REAL (radians between -PI and PI)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T ATAN2(T y, T x) noexcept {
    return T(std::atan2(static_cast<double>(iec_unwrap(y)), static_cast<double>(iec_unwrap(x))));
}

namespace detail {
/**
 * REAL/LREAL to a non-bool integer: NaN gives 0, out-of-range saturates (a
 * plain cast would be undefined behaviour). `truncate` picks trunc over round.
 */
template<typename ToVal>
inline ToVal iec_float_to_int(double v, bool truncate) noexcept {
    if (v != v) return static_cast<ToVal>(0);
    const double r = truncate ? std::trunc(v) : std::round(v);
    if (r >= static_cast<double>(std::numeric_limits<ToVal>::max()))
        return std::numeric_limits<ToVal>::max();
    if (r <= static_cast<double>(std::numeric_limits<ToVal>::min()))
        return std::numeric_limits<ToVal>::min();
    return static_cast<ToVal>(r);
}
}  // namespace detail

/**
 * TRUNC - Truncate toward zero
 * Input: ANY_REAL, Output: DINT for REAL, LINT for LREAL (saturating)
 */
template<typename T, enable_if_any_real<T> = 0>
inline auto TRUNC(T value) noexcept
    -> std::conditional_t<
        std::is_same<std::decay_t<decltype(iec_unwrap(value))>, float>::value,
        IEC_DINT, IEC_LINT> {
    using R = std::conditional_t<
        std::is_same<std::decay_t<decltype(iec_unwrap(value))>, float>::value,
        IEC_DINT, IEC_LINT>;
    return R(detail::iec_float_to_int<typename R::value_type>(
        static_cast<double>(iec_unwrap(value)), true));
}

namespace detail {
/**
 * Typed truncation into the integer IECVar R: the argument is first taken
 * as the float type F (REAL or LREAL), then truncated as TRUNC does.
 */
template<typename R, typename F, typename T>
inline R iec_trunc_to(T value) noexcept {
    return R(iec_float_to_int<typename R::value_type>(
        static_cast<double>(static_cast<F>(iec_unwrap(value))), true));
}
}  // namespace detail

/**
 * Typed truncation (IEC 61131-3 Ed. 3, Table 22): TRUNC_<int> takes any
 * ANY_REAL, REAL_TRUNC_<int> / LREAL_TRUNC_<int> that type. Toward zero,
 * saturating at the target's limits, NaN gives 0.
 */
#define STRUCPP_TYPED_TRUNC(INT)                                            \
    template<typename T>                                                    \
    inline IEC_##INT TRUNC_##INT(T value) noexcept {                        \
        return detail::iec_trunc_to<IEC_##INT, double>(value);             \
    }                                                                       \
    template<typename T>                                                    \
    inline IEC_##INT REAL_TRUNC_##INT(T value) noexcept {                   \
        return detail::iec_trunc_to<IEC_##INT, float>(value);              \
    }                                                                       \
    template<typename T>                                                    \
    inline IEC_##INT LREAL_TRUNC_##INT(T value) noexcept {                  \
        return detail::iec_trunc_to<IEC_##INT, double>(value);             \
    }
STRUCPP_TYPED_TRUNC(SINT)
STRUCPP_TYPED_TRUNC(INT)
STRUCPP_TYPED_TRUNC(DINT)
STRUCPP_TYPED_TRUNC(LINT)
STRUCPP_TYPED_TRUNC(USINT)
STRUCPP_TYPED_TRUNC(UINT)
STRUCPP_TYPED_TRUNC(UDINT)
STRUCPP_TYPED_TRUNC(ULINT)
#undef STRUCPP_TYPED_TRUNC

/**
 * ROUND - Round to nearest integer
 * Input: ANY_REAL, Output: ANY_REAL
 * Rounds half away from zero (banker's rounding not used)
 */
template<typename T, enable_if_any_real<T> = 0>
inline T ROUND(T value) noexcept {
    return T(std::round(static_cast<double>(iec_unwrap(value))));
}

// =============================================================================
// String comparison
// =============================================================================

namespace detail {
/** The characters of a STRING value, or of a WSTRING value's UTF-16 code units. */
template<typename C>
struct iec_str_text {
    const C* data;
    size_t length;
};

inline iec_str_text<char> iec_str_text_of(const char* s) noexcept {
    return {s ? s : "", s ? std::strlen(s) : 0};
}
inline iec_str_text<char16_t> iec_str_text_of(const char16_t* s) noexcept {
    size_t n = 0;
    if (s) while (s[n] != 0) ++n;
    return {s ? s : u"", n};
}
template<size_t N>
iec_str_text<char> iec_str_text_of(const IECString<N>& s) noexcept {
    return {s.c_str(), s.length()};
}
template<size_t N>
iec_str_text<char> iec_str_text_of(const IECStringVar<N>& s) noexcept {
    return {s.c_str(), s.length()};
}
template<size_t N>
iec_str_text<char16_t> iec_str_text_of(const IECWString<N>& s) noexcept {
    return {s.c_str(), s.length()};
}
template<size_t N>
iec_str_text<char16_t> iec_str_text_of(const IECWStringVar<N>& s) noexcept {
    return {s.c_str(), s.length()};
}
/** A wrapper of a string value (IECVar, a global's read value): its value's text. */
template<typename T>
auto iec_str_text_of(const T& v) noexcept -> decltype(iec_str_text_of(v.get())) {
    return iec_str_text_of(v.get());
}

/** strcmp order, by unsigned character or code unit, then by length. */
template<typename C>
int iec_str_text_cmp(iec_str_text<C> a, iec_str_text<C> b) noexcept {
    using U = std::make_unsigned_t<C>;
    const size_t n = a.length < b.length ? a.length : b.length;
    for (size_t i = 0; i < n; ++i) {
        const U x = static_cast<U>(a.data[i]);
        const U y = static_cast<U>(b.data[i]);
        if (x != y) return x < y ? -1 : 1;
    }
    return a.length == b.length ? 0 : (a.length < b.length ? -1 : 1);
}
}  // namespace detail

/**
 * Compare two STRING or two WSTRING values by their text: negative, zero or
 * positive as `a` is before, equal to or after `b`. Takes literals, string
 * values, string variables and their wrappers alike.
 */
template<typename A, typename B>
inline int iec_str_cmp(const A& a, const B& b) noexcept {
    return detail::iec_str_text_cmp(detail::iec_str_text_of(a), detail::iec_str_text_of(b));
}

// =============================================================================
// Selection Functions (ANY_ELEMENTARY for comparisons)
// =============================================================================

/**
 * SEL - Binary selection
 * Input: BOOL selector, ANY values, Output: ANY (same type as inputs)
 * Returns in1 if g is FALSE, in0 if g is TRUE
 */
template<typename T>
inline T SEL(IEC_BOOL g, T in0, T in1) noexcept {
    return iec_unwrap(g) ? in1 : in0;
}

/**
 * MAX - Maximum of two values
 * Input: ANY_ELEMENTARY, Output: ANY_ELEMENTARY (same type)
 */
template<typename T, enable_if_any_elementary<T> = 0>
inline T MAX(T a, T b) noexcept {
    return iec_unwrap(a) > iec_unwrap(b) ? a : b;
}

/**
 * MIN - Minimum of two values
 * Input: ANY_ELEMENTARY, Output: ANY_ELEMENTARY (same type)
 */
template<typename T, enable_if_any_elementary<T> = 0>
inline T MIN(T a, T b) noexcept {
    return iec_unwrap(a) < iec_unwrap(b) ? a : b;
}

/**
 * LIMIT - Limit value to range [mn, mx]
 * Input: ANY_ELEMENTARY, Output: ANY_ELEMENTARY (same type)
 */
template<typename T, enable_if_any_elementary<T> = 0>
inline T LIMIT(T mn, T in, T mx) noexcept {
    if (iec_unwrap(in) < iec_unwrap(mn)) return mn;
    if (iec_unwrap(in) > iec_unwrap(mx)) return mx;
    return in;
}

// MAX, MIN and LIMIT of STRING or WSTRING literals compare their text
inline const char* MAX(const char* a, const char* b) noexcept { return iec_str_cmp(a, b) > 0 ? a : b; }
inline const char* MIN(const char* a, const char* b) noexcept { return iec_str_cmp(a, b) < 0 ? a : b; }
inline const char* LIMIT(const char* mn, const char* in, const char* mx) noexcept {
    if (iec_str_cmp(in, mn) < 0) return mn;
    if (iec_str_cmp(in, mx) > 0) return mx;
    return in;
}
inline const char16_t* MAX(const char16_t* a, const char16_t* b) noexcept { return iec_str_cmp(a, b) > 0 ? a : b; }
inline const char16_t* MIN(const char16_t* a, const char16_t* b) noexcept { return iec_str_cmp(a, b) < 0 ? a : b; }
inline const char16_t* LIMIT(const char16_t* mn, const char16_t* in, const char16_t* mx) noexcept {
    if (iec_str_cmp(in, mn) < 0) return mn;
    if (iec_str_cmp(in, mx) > 0) return mx;
    return in;
}

// Mixed-type MIN/MAX/LIMIT/SEL overloads (OSCAT mixes e.g. INT with DINT)
template<typename T, typename U,
    std::enable_if_t<!std::is_same<std::decay_t<T>, std::decay_t<U>>::value, int> = 0>
inline auto MAX(T a, U b) noexcept {
    using CT = std::common_type_t<decltype(iec_unwrap(a)), decltype(iec_unwrap(b))>;
    auto va = static_cast<CT>(iec_unwrap(a));
    auto vb = static_cast<CT>(iec_unwrap(b));
    return va > vb ? va : vb;
}

template<typename T, typename U,
    std::enable_if_t<!std::is_same<std::decay_t<T>, std::decay_t<U>>::value, int> = 0>
inline auto MIN(T a, U b) noexcept {
    using CT = std::common_type_t<decltype(iec_unwrap(a)), decltype(iec_unwrap(b))>;
    auto va = static_cast<CT>(iec_unwrap(a));
    auto vb = static_cast<CT>(iec_unwrap(b));
    return va < vb ? va : vb;
}

template<typename T1, typename T2, typename T3>
inline auto LIMIT(T1 mn, T2 in, T3 mx) noexcept
    -> std::enable_if_t<
        !(std::is_same<std::decay_t<T1>, std::decay_t<T2>>::value &&
          std::is_same<std::decay_t<T2>, std::decay_t<T3>>::value),
        std::common_type_t<decltype(iec_unwrap(mn)), decltype(iec_unwrap(in)), decltype(iec_unwrap(mx))>> {
    using CT = std::common_type_t<decltype(iec_unwrap(mn)), decltype(iec_unwrap(in)), decltype(iec_unwrap(mx))>;
    auto vmn = static_cast<CT>(iec_unwrap(mn));
    auto vin = static_cast<CT>(iec_unwrap(in));
    auto vmx = static_cast<CT>(iec_unwrap(mx));
    if (vin < vmn) return vmn;
    if (vin > vmx) return vmx;
    return vin;
}

template<typename T, typename U,
    std::enable_if_t<!std::is_same<std::decay_t<T>, std::decay_t<U>>::value, int> = 0>
inline auto SEL(IEC_BOOL g, T in0, U in1) noexcept {
    using CT = std::common_type_t<decltype(iec_unwrap(in0)), decltype(iec_unwrap(in1))>;
    return iec_unwrap(g) ? static_cast<CT>(iec_unwrap(in1)) : static_cast<CT>(iec_unwrap(in0));
}

/**
 * MUX - Multiplexer (extensible — IEC 61131-3 minArgs=3, K + at least
 * two inputs).  Returns the input selected by the zero-based `k`:
 *
 *     MUX(0, A, B, C, D) == A
 *     MUX(2, A, B, C, D) == C
 *
 * The single-input terminator `MUX(k, in0)` exists only to anchor
 * the variadic recursion; callers should not invoke it directly
 * (the IEC contract requires K + ≥2 inputs).  When `k` is out of
 * range we fall through to the last input, matching the editor's
 * legacy 2-input behaviour and consistent with how CODESYS clamps
 * over-range selectors.
 */
template<typename T>
inline T MUX([[maybe_unused]] IEC_INT k, T in0) noexcept {
    return in0;
}

template<typename T, typename... Args>
inline T MUX(IEC_INT k, T in0, T in1, Args... rest) noexcept {
    if (iec_unwrap(k) == 0) return in0;
    return MUX(IEC_INT(iec_unwrap(k) - 1), in1, rest...);
}

// Inputs of different C++ types (an enumeration variable next to a literal
// of its enumeration): selected as their common raw type.
template<typename T, typename U, typename... Args,
    std::enable_if_t<!std::is_same<std::decay_t<T>, std::decay_t<U>>::value, int> = 0>
inline auto MUX(IEC_INT k, T in0, U in1, Args... rest) noexcept {
    using CT = std::common_type_t<decltype(iec_unwrap(in0)),
        decltype(iec_unwrap(in1)), decltype(iec_unwrap(rest))...>;
    return MUX(k, static_cast<CT>(iec_unwrap(in0)),
        static_cast<CT>(iec_unwrap(in1)), static_cast<CT>(iec_unwrap(rest))...);
}

// =============================================================================
// Comparison Functions (ANY_ELEMENTARY -> BOOL)
// =============================================================================

// Comparison operators take two arguments deduced independently — that way
// `LE(real_var, 0.0)` (where the literal is double / IEC_LREAL) and
// `EQ(my_int, 0)` (where the literal is int / IEC_INT) both type-check
// without forcing the caller to wrap every literal in a cast. Each side
// only has to land on an IEC elementary type after `iec_unwrap`; the
// comparison itself uses C++'s usual arithmetic conversions to find a
// common type.
//
// CONVERSION SEMANTICS — read this before writing cross-sign tests:
// Mixing signed and unsigned operands follows C++'s usual arithmetic
// conversions, not an IEC rule.
//
//   - When the unsigned operand has *lower* integer rank than `int`
//     (IEC_USINT, IEC_UINT — uint8/uint16), both sides are promoted to
//     `int` and the compare happens in signed land. No wrap.
//
//   - When the unsigned operand has rank >= `int` (IEC_UDINT, IEC_ULINT —
//     uint32/uint64) the signed operand converts to the unsigned type
//     and a negative value wraps to a large unsigned. So
//     `EQ(IEC_UDINT(0xFFFFFFFFu), -1)` is TRUE because -1 becomes
//     0xFFFFFFFF before the compare.
//
// STruC++ does not insert extra guards: IEC 61131-3 doesn't define
// cross-sign-class comparison, and we want the generated C++ to behave
// predictably under standard rules. If a project needs sign-strict
// comparisons, cast both sides to the same type before calling
// EQ/NE/LT/LE/GT/GE.
template<typename A, typename B>
using enable_if_two_elementary = std::enable_if_t<
    is_any_elementary_v<iec_underlying_type_t<std::decay_t<A>>> &&
        is_any_elementary_v<iec_underlying_type_t<std::decay_t<B>>>,
    int>;

/**
 * GT - Greater than
 * Input: ANY_ELEMENTARY, Output: BOOL
 */
template<typename A, typename B, enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL GT(A a, B b) noexcept {
    return IEC_BOOL(iec_unwrap(a) > iec_unwrap(b));
}

/**
 * GE - Greater than or equal
 * Input: ANY_ELEMENTARY, Output: BOOL
 */
template<typename A, typename B, enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL GE(A a, B b) noexcept {
    return IEC_BOOL(iec_unwrap(a) >= iec_unwrap(b));
}

/**
 * EQ - Equal
 * Input: ANY_ELEMENTARY, Output: BOOL
 */
template<typename A, typename B, enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL EQ(A a, B b) noexcept {
    return IEC_BOOL(iec_unwrap(a) == iec_unwrap(b));
}

/**
 * LE - Less than or equal
 * Input: ANY_ELEMENTARY, Output: BOOL
 */
template<typename A, typename B, enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL LE(A a, B b) noexcept {
    return IEC_BOOL(iec_unwrap(a) <= iec_unwrap(b));
}

/**
 * LT - Less than
 * Input: ANY_ELEMENTARY, Output: BOOL
 */
template<typename A, typename B, enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL LT(A a, B b) noexcept {
    return IEC_BOOL(iec_unwrap(a) < iec_unwrap(b));
}

/**
 * NE - Not equal
 * Input: ANY_ELEMENTARY, Output: BOOL
 */
template<typename A, typename B, enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL NE(A a, B b) noexcept {
    return IEC_BOOL(iec_unwrap(a) != iec_unwrap(b));
}

// ---------------------------------------------------------------------------
// Variadic chain forms for GT / GE / EQ / LE / LT / NE
// ---------------------------------------------------------------------------
//
// IEC 61131-3 defines the comparison functions as extensible:
// `GT(a, b, c)` means `(a > b) AND (b > c)`.  These overloads
// implement the chain semantic and live alongside the binary forms
// above so the codegen can emit the same C++ name for any arity.
//
// Same heterogeneous-type signature as the binary forms — every
// adjacent pair goes through `iec_unwrap` independently so mixed
// IECVar / underlying types compare cleanly.

template<typename A, typename B, typename C, typename... Rest,
         enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL GT(A a, B b, C c, Rest... rest) noexcept {
    if (!(iec_unwrap(a) > iec_unwrap(b))) return IEC_BOOL(false);
    return GT(b, c, rest...);
}

template<typename A, typename B, typename C, typename... Rest,
         enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL GE(A a, B b, C c, Rest... rest) noexcept {
    if (!(iec_unwrap(a) >= iec_unwrap(b))) return IEC_BOOL(false);
    return GE(b, c, rest...);
}

template<typename A, typename B, typename C, typename... Rest,
         enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL EQ(A a, B b, C c, Rest... rest) noexcept {
    if (!(iec_unwrap(a) == iec_unwrap(b))) return IEC_BOOL(false);
    return EQ(b, c, rest...);
}

template<typename A, typename B, typename C, typename... Rest,
         enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL LE(A a, B b, C c, Rest... rest) noexcept {
    if (!(iec_unwrap(a) <= iec_unwrap(b))) return IEC_BOOL(false);
    return LE(b, c, rest...);
}

template<typename A, typename B, typename C, typename... Rest,
         enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL LT(A a, B b, C c, Rest... rest) noexcept {
    if (!(iec_unwrap(a) < iec_unwrap(b))) return IEC_BOOL(false);
    return LT(b, c, rest...);
}

template<typename A, typename B, typename C, typename... Rest,
         enable_if_two_elementary<A, B> = 0>
inline IEC_BOOL NE(A a, B b, C c, Rest... rest) noexcept {
    if (!(iec_unwrap(a) != iec_unwrap(b))) return IEC_BOOL(false);
    return NE(b, c, rest...);
}

// =============================================================================
// VAR_TEMP reset
// =============================================================================

/**
 * Rebuild `x` in place as a fresh object (a VAR_TEMP holding a function block
 * instance), so a member that refers to another of its members (a POINTER TO
 * set at construction) refers to `x`'s own, not to a destroyed temporary.
 */
template<typename T>
inline void iec_reset_in_place(T& x) {
    x.~T();
    new (&x) T();
}

/**
 * Ends `x`'s lifetime and returns its storage, for `new (iec_destroyed(x)) T(init)`:
 * the initial value is built in that storage, not copied from a temporary.
 */
template<typename T>
inline void* iec_destroyed(T& x) noexcept {
    x.~T();
    return static_cast<void*>(&x);
}

// =============================================================================
// Bit Shift Functions (ANY_BIT -> ANY_BIT)
// =============================================================================

/** Width in bits of the value a shift operates on (1 for BOOL). */
template<typename T>
constexpr int iec_bit_width() noexcept {
    return std::is_same<iec_underlying_type_t<T>, bool>::value
        ? 1
        : static_cast<int>(sizeof(iec_underlying_type_t<T>) * 8);
}

namespace detail {
template<typename V>
constexpr bool iec_is_negative(V v, std::true_type /*signed*/) noexcept { return v < 0; }
template<typename V>
constexpr bool iec_is_negative(V, std::false_type) noexcept { return false; }
}  // namespace detail

/**
 * A shift count as an int: -1 when negative, at most 1024, so a count wider
 * than int is not truncated (2^32 stays at or above every width).
 */
template<typename N>
constexpr int iec_shift_count(N n) noexcept {
    return detail::iec_is_negative(iec_unwrap(n),
               std::is_signed<decltype(iec_unwrap(n))>{})
        ? -1
        : (static_cast<unsigned long long>(iec_unwrap(n)) > 1024ULL
               ? 1024
               : static_cast<int>(iec_unwrap(n)));
}

/**
 * SHL - Shift left
 * Input: ANY_BIT, ANY_INT (shift count), Output: ANY_BIT
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T SHL(T in, IEC_INT n) noexcept {
    auto shift = iec_unwrap(n);
    if (shift <= 0) return shift == 0 ? in : T(0);
    if (shift >= iec_bit_width<T>()) return T(0);
    return T(iec_unwrap(in) << shift);
}

// Mixed-type shift count overloads (OSCAT uses various integer types for shift amount)
template<typename T, typename N,
    enable_if_any_bit<T> = 0,
    std::enable_if_t<!std::is_same<std::decay_t<N>, IEC_INT>::value, int> = 0>
inline T SHL(T in, N n) noexcept {
    auto shift = iec_shift_count(n);
    if (shift <= 0) return shift == 0 ? in : T(0);
    if (shift >= iec_bit_width<T>()) return T(0);
    return T(iec_unwrap(in) << shift);
}

/**
 * SHR - Shift right
 * Input: ANY_BIT, ANY_INT (shift count), Output: ANY_BIT
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T SHR(T in, IEC_INT n) noexcept {
    auto shift = iec_unwrap(n);
    if (shift <= 0) return shift == 0 ? in : T(0);
    if (shift >= iec_bit_width<T>()) return T(0);
    return T(iec_unwrap(in) >> shift);
}

// Mixed-type shift count overloads
template<typename T, typename N,
    enable_if_any_bit<T> = 0,
    std::enable_if_t<!std::is_same<std::decay_t<N>, IEC_INT>::value, int> = 0>
inline T SHR(T in, N n) noexcept {
    auto shift = iec_shift_count(n);
    if (shift <= 0) return shift == 0 ? in : T(0);
    if (shift >= iec_bit_width<T>()) return T(0);
    return T(iec_unwrap(in) >> shift);
}

// SHL/SHR for signed integer types (CODESYS extension, used by OSCAT)
// IEC standard restricts to ANY_BIT, but CODESYS allows ANY_INT
template<typename T, typename N,
    std::enable_if_t<is_any_int_v<T> && !is_any_bit_v<T>, int> = 0>
inline T SHL(T in, N n) noexcept {
    auto shift = iec_shift_count(n);
    if (shift <= 0) return shift == 0 ? in : T(0);
    if (shift >= iec_bit_width<T>()) return T(0);
    using UT = std::make_unsigned_t<iec_underlying_type_t<T>>;
    return T(static_cast<iec_underlying_type_t<T>>(
        static_cast<UT>(iec_unwrap(in)) << shift));
}

template<typename T, typename N,
    std::enable_if_t<is_any_int_v<T> && !is_any_bit_v<T>, int> = 0>
inline T SHR(T in, N n) noexcept {
    auto shift = iec_shift_count(n);
    if (shift <= 0) return shift == 0 ? in : T(0);
    if (shift >= iec_bit_width<T>()) shift = iec_bit_width<T>() - 1;
    return T(iec_unwrap(in) >> shift);
}

/**
 * ROL - Rotate left
 * Input: ANY_BIT, ANY_INT (shift count), Output: ANY_BIT
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T ROL(T in, IEC_INT n) noexcept {
    constexpr int bits = sizeof(iec_underlying_type_t<T>) * 8;
    auto v = iec_unwrap(in);
    auto shift = iec_unwrap(n) % bits;
    if (shift < 0) shift += bits; // IEC 61131-3: negative N reverses direction
    if (shift == 0) return in;
    return T((v << shift) | (v >> (bits - shift)));
}

// Mixed-type rotate overloads
template<typename T, typename N,
    enable_if_any_bit<T> = 0,
    std::enable_if_t<!std::is_same<std::decay_t<N>, IEC_INT>::value, int> = 0>
inline T ROL(T in, N n) noexcept {
    constexpr int bits = sizeof(iec_underlying_type_t<T>) * 8;
    auto v = iec_unwrap(in);
    auto shift = static_cast<int>(iec_unwrap(n)) % bits;
    if (shift < 0) shift += bits; // IEC 61131-3: negative N reverses direction
    if (shift == 0) return in;
    return T((v << shift) | (v >> (bits - shift)));
}

/**
 * ROR - Rotate right
 * Input: ANY_BIT, ANY_INT (shift count), Output: ANY_BIT
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T ROR(T in, IEC_INT n) noexcept {
    constexpr int bits = sizeof(iec_underlying_type_t<T>) * 8;
    auto v = iec_unwrap(in);
    auto shift = iec_unwrap(n) % bits;
    if (shift < 0) shift += bits; // IEC 61131-3: negative N reverses direction
    if (shift == 0) return in;
    return T((v >> shift) | (v << (bits - shift)));
}

// Mixed-type rotate overloads
template<typename T, typename N,
    enable_if_any_bit<T> = 0,
    std::enable_if_t<!std::is_same<std::decay_t<N>, IEC_INT>::value, int> = 0>
inline T ROR(T in, N n) noexcept {
    constexpr int bits = sizeof(iec_underlying_type_t<T>) * 8;
    auto v = iec_unwrap(in);
    auto shift = static_cast<int>(iec_unwrap(n)) % bits;
    if (shift < 0) shift += bits; // IEC 61131-3: negative N reverses direction
    if (shift == 0) return in;
    return T((v >> shift) | (v << (bits - shift)));
}

// =============================================================================
// Type Conversion Functions
// =============================================================================

/**
 * Helper: round-then-cast for REAL→integer conversions per IEC 61131-3
 */
namespace detail {
template<typename ToVal>
inline ToVal iec_convert_value_impl2(double v, std::true_type /*bool*/) noexcept {
    return static_cast<ToVal>(std::round(v));
}
template<typename ToVal>
inline ToVal iec_convert_value_impl2(double v, std::false_type) noexcept {
    return iec_float_to_int<ToVal>(v, false);
}
template<typename ToVal, typename FromVal>
inline ToVal iec_convert_value_impl(FromVal value, std::true_type /*round*/) noexcept {
    return iec_convert_value_impl2<ToVal>(
        static_cast<double>(value), std::is_same<ToVal, bool>{});
}
template<typename ToVal, typename FromVal>
inline ToVal iec_convert_value_impl(FromVal value, std::false_type) noexcept {
    return static_cast<ToVal>(value);
}

/** A conversion source as a number: an enumeration as its underlying integer, anything else as is. */
template<typename T>
constexpr T iec_conversion_source(T value) noexcept { return value; }
template<typename E>
constexpr std::underlying_type_t<E> iec_conversion_source(const IEC_ENUM_Value<E>& value) noexcept {
    return static_cast<std::underlying_type_t<E>>(value.get());
}
template<typename E>
constexpr std::underlying_type_t<E> iec_conversion_source(const IEC_ENUM_Var<E>& value) noexcept {
    return static_cast<std::underlying_type_t<E>>(static_cast<E>(value));
}
}  // namespace detail

template<typename ToVal, typename FromVal>
inline ToVal iec_convert_value(FromVal value) noexcept {
    // IEC 61131-3: REAL/LREAL to integer types use rounding (nearest)
    return detail::iec_convert_value_impl<ToVal>(
        value,
        std::integral_constant<bool, std::is_floating_point<FromVal>::value &&
                                     std::is_integral<ToVal>::value>{});
}

/**
 * Generic type conversion (IECVar → IECVar)
 */
template<typename To, typename From>
inline auto CONVERT(From value) noexcept
    -> std::enable_if_t<!std::is_arithmetic<From>::value, To> {
    return To(iec_convert_value<typename To::value_type>(
        detail::iec_conversion_source(iec_unwrap(value))));
}

/**
 * Generic type conversion (arithmetic → IECVar)
 */
template<typename To, typename From>
inline auto CONVERT(From value) noexcept
    -> std::enable_if_t<std::is_arithmetic<From>::value, To> {
    return To(iec_convert_value<typename To::value_type>(value));
}

// Specific conversion functions (aliases for clarity)
template<typename T> inline IEC_BOOL TO_BOOL(T v) noexcept { return CONVERT<IEC_BOOL>(v); }
template<typename T> inline IEC_SINT TO_SINT(T v) noexcept { return CONVERT<IEC_SINT>(v); }
template<typename T> inline IEC_INT TO_INT(T v) noexcept { return CONVERT<IEC_INT>(v); }
template<typename T> inline IEC_DINT TO_DINT(T v) noexcept { return CONVERT<IEC_DINT>(v); }
template<typename T> inline IEC_LINT TO_LINT(T v) noexcept { return CONVERT<IEC_LINT>(v); }
template<typename T> inline IEC_USINT TO_USINT(T v) noexcept { return CONVERT<IEC_USINT>(v); }
template<typename T> inline IEC_UINT TO_UINT(T v) noexcept { return CONVERT<IEC_UINT>(v); }
template<typename T> inline IEC_UDINT TO_UDINT(T v) noexcept { return CONVERT<IEC_UDINT>(v); }
template<typename T> inline IEC_ULINT TO_ULINT(T v) noexcept { return CONVERT<IEC_ULINT>(v); }
template<typename T> inline IEC_REAL TO_REAL(T v) noexcept { return CONVERT<IEC_REAL>(v); }
template<typename T> inline IEC_LREAL TO_LREAL(T v) noexcept { return CONVERT<IEC_LREAL>(v); }
template<typename T> inline IEC_BYTE TO_BYTE(T v) noexcept { return CONVERT<IEC_BYTE>(v); }
template<typename T> inline IEC_WORD TO_WORD(T v) noexcept { return CONVERT<IEC_WORD>(v); }
template<typename T> inline IEC_DWORD TO_DWORD(T v) noexcept { return CONVERT<IEC_DWORD>(v); }
template<typename T> inline IEC_LWORD TO_LWORD(T v) noexcept { return CONVERT<IEC_LWORD>(v); }

// Time/Date conversion functions
// These take the value ALREADY in the target's unit: ms for TIME and TOD,
// seconds for DATE and DT (modulo 2^32), ns for LTIME, LTOD and LDT, days for
// LDATE. Unit scaling of an integer argument is applied by codegen (see
// `TEMPORAL_CONVERSION_UNITS` in codegen.ts). A temporal argument of the
// other width converts by its meaning (TO_LTIME of a TIME gives ns).

/** The raw count of a number or a 32-bit temporal value. */
template<typename T, std::enable_if_t<std::is_arithmetic<T>::value, int> = 0>
constexpr T iec_raw(T v) noexcept { return v; }
template<int K>
constexpr uint32_t iec_raw(IecTemporal32<K> v) noexcept { return v.raw; }

/** A count modulo 2^32, as the 32-bit temporal types hold it. */
template<typename T>
inline uint32_t iec_wrap32(T v) noexcept {
    return static_cast<uint32_t>(static_cast<uint64_t>(static_cast<int64_t>(v)));
}

template<typename T> inline IEC_TIME TO_TIME(T v) noexcept {
    return IEC_TIME(TIME_t(iec_wrap32(iec_raw(iec_unwrap(v)))));
}
template<typename T> inline IEC_DATE TO_DATE(T v) noexcept {
    return IEC_DATE(DATE_t(iec_wrap32(iec_raw(iec_unwrap(v)))));
}
template<typename T> inline IEC_DT TO_DT(T v) noexcept {
    return IEC_DT(DT_t(iec_wrap32(iec_raw(iec_unwrap(v)))));
}
template<typename T> inline IEC_TOD TO_TOD(T v) noexcept {
    return IEC_TOD(TOD_t(iec_wrap32(iec_raw(iec_unwrap(v)))));
}

template<typename T> inline IEC_LTIME TO_LTIME(T v) noexcept {
    return IEC_LTIME(static_cast<LTIME_t>(iec_raw(iec_unwrap(v))));
}
template<typename T> inline IEC_LDATE TO_LDATE(T v) noexcept {
    return IEC_LDATE(static_cast<LDATE_t>(iec_raw(iec_unwrap(v))));
}
template<typename T> inline IEC_LTOD TO_LTOD(T v) noexcept {
    return IEC_LTOD(static_cast<LTOD_t>(iec_raw(iec_unwrap(v))));
}
template<typename T> inline IEC_LDT TO_LDT(T v) noexcept {
    return IEC_LDT(static_cast<LDT_t>(iec_raw(iec_unwrap(v))));
}

// A 32-bit value to its long form, by its meaning
inline IEC_LTIME TO_LTIME(TIME_t t) noexcept { return IEC_LTIME(TIME_AS_NS(t)); }
inline IEC_LTIME TO_LTIME(const IEC_TIME& t) noexcept { return TO_LTIME(t.get()); }
inline IEC_LDATE TO_LDATE(DATE_t d) noexcept { return IEC_LDATE(DATE_AS_DAYS(d)); }
inline IEC_LDATE TO_LDATE(const IEC_DATE& d) noexcept { return TO_LDATE(d.get()); }
inline IEC_LTOD TO_LTOD(TOD_t t) noexcept { return IEC_LTOD(TOD_AS_NS(t)); }
inline IEC_LTOD TO_LTOD(const IEC_TOD& t) noexcept { return TO_LTOD(t.get()); }
inline IEC_LDT TO_LDT(DT_t d) noexcept { return IEC_LDT(DT_AS_NS(d)); }
inline IEC_LDT TO_LDT(const IEC_DT& d) noexcept { return TO_LDT(d.get()); }

// A long value (a count in its own unit) to the 32-bit form
inline IEC_TIME LTIME_TO_TIME_VALUE(int64_t ns) noexcept { return IEC_TIME(TIME_OF_NS(ns)); }
inline IEC_TOD LTOD_TO_TOD_VALUE(int64_t ns) noexcept { return IEC_TOD(TOD_OF_NS(ns)); }
inline IEC_DT LDT_TO_DT_VALUE(int64_t ns) noexcept { return IEC_DT(DT_OF_NS(ns)); }
inline IEC_DATE LDATE_TO_DATE_VALUE(int64_t days) noexcept { return IEC_DATE(DATE_OF_DAYS(days)); }

// CHAR is one Windows-1252 byte, WCHAR one UTF-16 code unit. A bit string or
// integer converts by its value (codegen passes a CHAR source as its code);
// CHAR and WCHAR convert through the Windows-1252 table, a WCHAR it lacks
// becoming '?'; a STRING or WSTRING gives its first character (0 when empty).
template<typename T> inline IEC_CHAR TO_CHAR(T v) noexcept {
    return IEC_CHAR(static_cast<CHAR_t>(iec_unwrap(v)));
}
inline IEC_CHAR TO_CHAR(WCHAR_t c) noexcept {
    const int byte = cp1252::from_unicode(c);
    return IEC_CHAR(static_cast<CHAR_t>(byte < 0 ? '?' : byte));
}
inline IEC_CHAR TO_CHAR(const IEC_WCHAR& c) noexcept { return TO_CHAR(c.get()); }
template<size_t N> inline IEC_CHAR TO_CHAR(const IECString<N>& s) noexcept {
    return IEC_CHAR(s.length() > 0 ? s.c_str()[0] : '\0');
}
template<size_t N> inline IEC_CHAR TO_CHAR(const IECStringVar<N>& s) noexcept { return TO_CHAR(s.get()); }

template<typename T> inline IEC_WCHAR TO_WCHAR(T v) noexcept {
    return IEC_WCHAR(static_cast<WCHAR_t>(iec_unwrap(v)));
}
inline IEC_WCHAR TO_WCHAR(CHAR_t c) noexcept {
    return IEC_WCHAR(static_cast<WCHAR_t>(cp1252::to_unicode(static_cast<unsigned char>(c))));
}
inline IEC_WCHAR TO_WCHAR(const IEC_CHAR& c) noexcept { return TO_WCHAR(c.get()); }
template<size_t N> inline IEC_WCHAR TO_WCHAR(const IECWString<N>& s) noexcept {
    return IEC_WCHAR(s.length() > 0 ? s[0] : u'\0');
}
template<size_t N> inline IEC_WCHAR TO_WCHAR(const IECWStringVar<N>& s) noexcept { return TO_WCHAR(s.get()); }

// ---------------------------------------------------------------------------
// STRING -> TIME / TOD / DATE / DT parsing
//
// The frontend lowers STRING_TO_TIME / STRING_TO_TOD / STRING_TO_DATE /
// STRING_TO_DT to TO_TIME / TO_TOD / TO_DATE / TO_DT. The numeric overloads
// above treat their argument as a raw count; the string overloads below PARSE
// the textual IEC literal (used by e.g. OSCAT's TIMER_EVENT_DECODE). Formats,
// each with an optional `PREFIX#`:
//   TIME : [T#]  (<num>(d|h|m|s|ms|us|ns))+        -> nanoseconds
//   TOD  : [TOD#] HH:MM[:SS[.fff]]                 -> ns since midnight
//   DATE : [D#] YYYY-MM-DD                         -> days since 1970-01-01
//   DT   : [DT#] YYYY-MM-DD-HH:MM[:SS[.fff]]       -> ns since the Unix epoch
// Lenient and exception-free (AVR-safe), with no undefined behaviour on any
// input: text holding no number yields 0; other characters it does not expect
// are skipped, and a value beyond the type's range wraps modulo 2^64.
// Fractions are read digit by digit, exactly to the nanosecond.
namespace iec_strparse {

// Skip a leading `IDENT#` literal prefix (e.g. "T#", "TOD#") if present.
inline const char* skip_literal_prefix(const char* s) noexcept {
    for (const char* p = s; *p; ++p) {
        if (*p == '#') return p + 1;
        const char c = *p;
        const bool idish = c == '_' || (c >= '0' && c <= '9') ||
                           (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        if (!idish) break;
    }
    return s;
}

/** The digits after a '.', exactly, as a count of `unit / 10^k` (digits past `unit`'s precision are dropped). */
inline uint64_t read_fraction(const char*& s, uint64_t unit) noexcept {
    uint64_t value = 0;
    while (*s >= '0' && *s <= '9') {
        unit /= 10u;
        value += static_cast<uint64_t>(*s - '0') * unit;
        ++s;
    }
    return value;
}

inline int64_t parse_time_ns(const char* s) noexcept {
    s = skip_literal_prefix(s);
    // A sign applies to the whole interval: T#-1s500ms is -1500 ms
    bool negative = false;
    if (*s == '-' || *s == '+') {
        negative = *s == '-';
        ++s;
    }
    // The magnitude, unsigned: the LTIME minimum's is 2^63
    uint64_t total = 0;
    while (*s) {
        if (!(*s >= '0' && *s <= '9') && *s != '.') { ++s; continue; }
        uint64_t whole = 0;
        while (*s >= '0' && *s <= '9') {
            whole = whole * 10u + static_cast<uint64_t>(*s - '0');
            ++s;
        }
        const char* frac_start = nullptr;
        if (*s == '.') frac_start = ++s;
        while (*s >= '0' && *s <= '9') ++s;  // the fraction, read once its unit is known
        const char u0 = (*s >= 'A' && *s <= 'Z') ? static_cast<char>(*s + 32) : *s;
        const char u1 = *s == '\0' ? '\0'
            : (s[1] >= 'A' && s[1] <= 'Z') ? static_cast<char>(s[1] + 32) : s[1];
        uint64_t mult = 1000000u; // default unit: milliseconds
        if (u0 == 'm' && u1 == 's') { mult = 1000000u; s += 2; }
        else if (u0 == 'u' && u1 == 's') { mult = 1000u; s += 2; }
        else if (u0 == 'n' && u1 == 's') { mult = 1u; s += 2; }
        else if (u0 == 'd') { mult = 86400000000000u; s += 1; }
        else if (u0 == 'h') { mult = 3600000000000u; s += 1; }
        else if (u0 == 'm') { mult = 60000000000u; s += 1; }
        else if (u0 == 's') { mult = 1000000000u; s += 1; }
        total += whole * mult;
        if (frac_start != nullptr) total += read_fraction(frac_start, mult);
    }
    // Negated in unsigned arithmetic, then read as the signed value it encodes
    return static_cast<int64_t>(negative ? 0u - total : total);
}

inline void read_int(const char*& s, long long& out) noexcept {
    char* end = nullptr;
    out = std::strtoll(s, &end, 10);
    if (end != s) s = end;
}

inline int64_t parse_tod_ns(const char* s) noexcept {
    s = skip_literal_prefix(s);
    long long hh = 0, mm = 0, ss = 0;
    read_int(s, hh);
    if (*s == ':') { ++s; read_int(s, mm); }
    if (*s == ':') { ++s; read_int(s, ss); }
    uint64_t frac_ns = 0;
    if (*s == '.') { ++s; frac_ns = read_fraction(s, 1000000000u); }
    return static_cast<int64_t>(
        static_cast<uint64_t>(hh) * 3600000000000u + static_cast<uint64_t>(mm) * 60000000000u +
        static_cast<uint64_t>(ss) * 1000000000u + frac_ns);
}

// Days from 1970-01-01 for a proleptic-Gregorian date (Hinnant's algorithm).
inline int64_t days_from_civil(long long y, long long m, long long d) noexcept {
    y -= (m <= 2);
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const long long yoe = y - era * 400;
    const long long doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

inline int64_t parse_date_days(const char* s) noexcept {
    s = skip_literal_prefix(s);
    long long y = 0, mo = 0, d = 0;
    read_int(s, y);
    if (*s == '-') { ++s; read_int(s, mo); }
    if (*s == '-') { ++s; read_int(s, d); }
    return days_from_civil(y, mo ? mo : 1, d ? d : 1);
}

inline int64_t parse_dt_ns(const char* s) noexcept {
    s = skip_literal_prefix(s);
    if (!(*s >= '0' && *s <= '9')) return 0;  // no date: 0, as for no number
    long long y = 0, mo = 0, d = 0, hh = 0, mm = 0, ss = 0;
    read_int(s, y);
    if (*s == '-') { ++s; read_int(s, mo); }
    if (*s == '-') { ++s; read_int(s, d); }
    if (*s == '-') { ++s; read_int(s, hh); }
    if (*s == ':') { ++s; read_int(s, mm); }
    if (*s == ':') { ++s; read_int(s, ss); }
    // A fraction of a second, to the nanosecond: DT#1969-12-31-23:59:59.5
    uint64_t frac_ns = 0;
    if (*s == '.') { ++s; frac_ns = read_fraction(s, 1000000000u); }
    // Modulo 2^64: the LDT minimum's day count times ns-per-day overflows
    // int64 before the time of day brings it back in range
    // Date fields far out of range are clamped, so the day count cannot overflow
    const auto clamp = [](long long v) noexcept {
        return v < -1000000000LL ? -1000000000LL : v > 1000000000LL ? 1000000000LL : v;
    };
    const uint64_t days = static_cast<uint64_t>(
        days_from_civil(clamp(y), mo ? clamp(mo) : 1, d ? clamp(d) : 1));
    return static_cast<int64_t>(
        days * 86400000000000u + static_cast<uint64_t>(hh) * 3600000000000u +
        static_cast<uint64_t>(mm) * 60000000000u + static_cast<uint64_t>(ss) * 1000000000u +
        frac_ns);
}

} // namespace iec_strparse

// String overloads (more specialized than the numeric TO_* templates, so they
// win overload resolution for STRING arguments). A 32-bit type takes the text
// truncated to its unit and modulo 2^32, as its arithmetic does: a negative
// TIME wraps, digits below a millisecond are dropped.
template<size_t N> inline IEC_TIME TO_TIME(const IECString<N>& s) noexcept { return IEC_TIME(TIME_OF_NS(iec_strparse::parse_time_ns(s.c_str()))); }
template<size_t N> inline IEC_TIME TO_TIME(const IECStringVar<N>& s) noexcept { return TO_TIME(s.get()); }
template<size_t N> inline IEC_LTIME TO_LTIME(const IECString<N>& s) noexcept { return IEC_LTIME(iec_strparse::parse_time_ns(s.c_str())); }
template<size_t N> inline IEC_LTIME TO_LTIME(const IECStringVar<N>& s) noexcept { return TO_LTIME(s.get()); }
template<size_t N> inline IEC_LTOD TO_LTOD(const IECString<N>& s) noexcept { return IEC_LTOD(iec_strparse::parse_tod_ns(s.c_str())); }
template<size_t N> inline IEC_LTOD TO_LTOD(const IECStringVar<N>& s) noexcept { return TO_LTOD(s.get()); }
template<size_t N> inline IEC_LDATE TO_LDATE(const IECString<N>& s) noexcept { return IEC_LDATE(iec_strparse::parse_date_days(s.c_str())); }
template<size_t N> inline IEC_LDATE TO_LDATE(const IECStringVar<N>& s) noexcept { return TO_LDATE(s.get()); }
template<size_t N> inline IEC_LDT TO_LDT(const IECString<N>& s) noexcept { return IEC_LDT(iec_strparse::parse_dt_ns(s.c_str())); }
template<size_t N> inline IEC_LDT TO_LDT(const IECStringVar<N>& s) noexcept { return TO_LDT(s.get()); }
template<size_t N> inline IEC_TOD TO_TOD(const IECString<N>& s) noexcept { return IEC_TOD(TOD_OF_NS(iec_strparse::parse_tod_ns(s.c_str()))); }
template<size_t N> inline IEC_TOD TO_TOD(const IECStringVar<N>& s) noexcept { return TO_TOD(s.get()); }
template<size_t N> inline IEC_DATE TO_DATE(const IECString<N>& s) noexcept { return IEC_DATE(DATE_OF_DAYS(iec_strparse::parse_date_days(s.c_str()))); }
template<size_t N> inline IEC_DATE TO_DATE(const IECStringVar<N>& s) noexcept { return TO_DATE(s.get()); }
template<size_t N> inline IEC_DT TO_DT(const IECString<N>& s) noexcept { return IEC_DT(DT_OF_NS(iec_strparse::parse_dt_ns(s.c_str()))); }
template<size_t N> inline IEC_DT TO_DT(const IECStringVar<N>& s) noexcept { return TO_DT(s.get()); }
// A STRING literal (a C++ string literal) parses the same way.
inline IEC_TIME TO_TIME(const char* s) noexcept { return IEC_TIME(TIME_OF_NS(iec_strparse::parse_time_ns(s))); }
inline IEC_LTIME TO_LTIME(const char* s) noexcept { return IEC_LTIME(iec_strparse::parse_time_ns(s)); }
inline IEC_TOD TO_TOD(const char* s) noexcept { return IEC_TOD(TOD_OF_NS(iec_strparse::parse_tod_ns(s))); }
inline IEC_LTOD TO_LTOD(const char* s) noexcept { return IEC_LTOD(iec_strparse::parse_tod_ns(s)); }
inline IEC_DATE TO_DATE(const char* s) noexcept { return IEC_DATE(DATE_OF_DAYS(iec_strparse::parse_date_days(s))); }
inline IEC_LDATE TO_LDATE(const char* s) noexcept { return IEC_LDATE(iec_strparse::parse_date_days(s)); }
inline IEC_DT TO_DT(const char* s) noexcept { return IEC_DT(DT_OF_NS(iec_strparse::parse_dt_ns(s))); }
inline IEC_LDT TO_LDT(const char* s) noexcept { return IEC_LDT(iec_strparse::parse_dt_ns(s)); }

// =============================================================================
// String / Wide String Conversion
// =============================================================================
//
// STRING <-> WSTRING per IEC 61131-3: character by character. A STRING
// holds Windows-1252 bytes, so each byte widens to its CP1252 code point
// (0x80 is U+20AC). Narrowing writes a WSTRING character CP1252 lacks as '?'
// (a surrogate pair counts as one character), as Windows' WideCharToMultiByte
// does with its default character.

template<size_t SrcLen>
inline IECWString<SrcLen> STRING_TO_WSTRING(const IECString<SrcLen>& src) noexcept {
    IECWString<SrcLen> result;
    const size_t n = src.length();
    for (size_t i = 0; i < n; ++i) {
        result.append(static_cast<char16_t>(
            cp1252::to_unicode(static_cast<unsigned char>(src[i]))));
    }
    return result;
}

// Overload for the per-variable wrapper.
template<size_t SrcLen>
inline IECWString<SrcLen> STRING_TO_WSTRING(const IECStringVar<SrcLen>& src) noexcept {
    return STRING_TO_WSTRING(src.get());
}

template<size_t SrcLen>
inline IECString<SrcLen> WSTRING_TO_STRING(const IECWString<SrcLen>& src) noexcept {
    IECString<SrcLen> result;
    const size_t n = src.length();
    for (size_t i = 0; i < n; ++i) {
        const char16_t unit = src[i];
        if (unit >= 0xD800u && unit <= 0xDBFFu && i + 1 < n
            && src[i + 1] >= 0xDC00u && src[i + 1] <= 0xDFFFu) {
            ++i;  // a surrogate pair is one character, outside CP1252
            result.append('?');
            continue;
        }
        const int byte = cp1252::from_unicode(unit);
        result.append(byte < 0 ? '?' : static_cast<char>(byte));
    }
    return result;
}

template<size_t SrcLen>
inline IECString<SrcLen> WSTRING_TO_STRING(const IECWStringVar<SrcLen>& src) noexcept {
    return WSTRING_TO_STRING(src.get());
}

// The canonical IEC literal of a duration or a date/time value, as the
// *_TO_STRING conversions give it: T#1h2m3s4ms, D#2024-03-05,
// TOD#12:34:56.789, DT#2024-03-05-12:34:56 (with the L prefixes for the long
// types). A unit or fraction that is zero is left out; zero is T#0ms.
namespace iec_literal_text {

inline void append_int(IECString<254>& out, int64_t v) noexcept {
    char buf[24];
    int n = 0;
    uint64_t u = static_cast<uint64_t>(v);
    do { buf[n++] = static_cast<char>('0' + u % 10); u /= 10; } while (u != 0);
    while (n > 0) out.append(buf[--n]);
}

inline void append_padded(IECString<254>& out, int64_t v, int width) noexcept {
    char buf[24];
    int n = 0;
    uint64_t u = static_cast<uint64_t>(v);
    do { buf[n++] = static_cast<char>('0' + u % 10); u /= 10; } while (u != 0);
    while (n < width) buf[n++] = '0';
    while (n > 0) out.append(buf[--n]);
}

inline void append_text(IECString<254>& out, const char* t) noexcept {
    while (*t) out.append(*t++);
}

/** `.fff` of a nanosecond fraction, trailing zeros left out; nothing for 0. */
inline void append_fraction(IECString<254>& out, int64_t ns) noexcept {
    if (ns == 0) return;
    int digits = 9;
    while (ns % 10 == 0) { ns /= 10; --digits; }
    out.append('.');
    append_padded(out, ns, digits);
}

/** Days since 1970-01-01 to year, month, day (proleptic Gregorian). */
inline void civil_from_days(int64_t z, int64_t& y, int64_t& m, int64_t& d) noexcept {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp < 10 ? mp + 3 : mp - 9;
    y = yoe + era * 400 + (m <= 2 ? 1 : 0);
}

inline void append_date(IECString<254>& out, int64_t days) noexcept {
    int64_t y, m, d;
    civil_from_days(days, y, m, d);
    append_padded(out, y, 4);
    out.append('-');
    append_padded(out, m, 2);
    out.append('-');
    append_padded(out, d, 2);
}

inline void append_clock(IECString<254>& out, int64_t ns_of_day) noexcept {
    const int64_t s = ns_of_day / 1000000000LL;
    append_padded(out, s / 3600, 2);
    out.append(':');
    append_padded(out, (s / 60) % 60, 2);
    out.append(':');
    append_padded(out, s % 60, 2);
    append_fraction(out, ns_of_day % 1000000000LL);
}

}  // namespace iec_literal_text

/** TIME / LTIME as `T#1h2m3s4ms` / `LTIME#...`. */
inline IECString<254> iec_duration_text(int64_t ns, const char* prefix) noexcept {
    using namespace iec_literal_text;
    IECString<254> out;
    append_text(out, prefix);
    uint64_t u = ns < 0 ? static_cast<uint64_t>(-(ns + 1)) + 1 : static_cast<uint64_t>(ns);
    if (ns < 0) out.append('-');
    if (u == 0) { append_text(out, "0ms"); return out; }
    const struct { uint64_t size; const char* unit; } parts[] = {
        {86400000000000ULL, "d"}, {3600000000000ULL, "h"}, {60000000000ULL, "m"},
        {1000000000ULL, "s"}, {1000000ULL, "ms"}, {1000ULL, "us"}, {1ULL, "ns"}};
    for (const auto& part : parts) {
        const uint64_t n = u / part.size;
        u %= part.size;
        if (n == 0) continue;
        append_int(out, static_cast<int64_t>(n));
        append_text(out, part.unit);
    }
    return out;
}

/** DATE or LDATE, days since 1970-01-01, as `D#2024-03-05` or `LDATE#...`. */
inline IECString<254> iec_date_text(int64_t days, const char* prefix) noexcept {
    IECString<254> out;
    iec_literal_text::append_text(out, prefix);
    iec_literal_text::append_date(out, days);
    return out;
}

/** TOD or LTOD, ns since midnight, as `TOD#12:34:56.789` or `LTOD#...`. */
inline IECString<254> iec_tod_text(int64_t ns, const char* prefix) noexcept {
    IECString<254> out;
    iec_literal_text::append_text(out, prefix);
    iec_literal_text::append_clock(out, ns);
    return out;
}

/** DT or LDT, ns since 1970-01-01, as `DT#2024-03-05-12:34:56` or `LDT#...`. */
inline IECString<254> iec_dt_text(int64_t ns, const char* prefix) noexcept {
    const int64_t day = 86400000000000LL;
    int64_t days = ns / day;
    int64_t rest = ns % day;
    if (rest < 0) { rest += day; --days; }
    IECString<254> out;
    iec_literal_text::append_text(out, prefix);
    iec_literal_text::append_date(out, days);
    out.append('-');
    iec_literal_text::append_clock(out, rest);
    return out;
}

// `*_TO_*` resolution in the frontend collapses STRING_TO_WSTRING /
// WSTRING_TO_STRING to plain TO_WSTRING / TO_STRING calls (cppName is
// `TO_${toType}`), so provide the matching aliases. Templated on the
// source type so they bind to either the bare class or the *Var
// wrapper without relying on conversions.

template<typename T>
inline auto TO_WSTRING(const T& src) noexcept -> decltype(STRING_TO_WSTRING(src)) {
    return STRING_TO_WSTRING(src);
}

template<typename T>
inline auto TO_STRING(const T& src) noexcept -> decltype(WSTRING_TO_STRING(src)) {
    return WSTRING_TO_STRING(src);
}

// A WSTRING or STRING literal (a C++ string literal) converts as its text,
// not as a pointer taken for a BOOL.
inline IECString<254> TO_STRING(const char16_t* src) noexcept {
    return WSTRING_TO_STRING(IECWString<254>(src));
}
inline IECWString<254> TO_WSTRING(const char* src) noexcept {
    return STRING_TO_WSTRING(IECString<254>(src));
}
inline IECString<254> TO_STRING(const char* src) noexcept {
    return IECString<254>(src);
}
inline IECWString<254> TO_WSTRING(const char16_t* src) noexcept {
    return IECWString<254>(src);
}

// A CHAR is the one-character STRING of it, a WCHAR the one-unit WSTRING.
inline IECString<254> TO_STRING(CHAR_t c) noexcept {
    IECString<254> r;
    r.append(c);
    return r;
}
inline IECString<254> TO_STRING(const IEC_CHAR& c) noexcept { return TO_STRING(c.get()); }
inline IECWString<254> TO_WSTRING(WCHAR_t c) noexcept {
    IECWString<254> r;
    r.append(c);
    return r;
}
inline IECWString<254> TO_WSTRING(const IEC_WCHAR& c) noexcept { return TO_WSTRING(c.get()); }

// Across the two widths, through Windows-1252: a CHAR is the one-unit WSTRING
// of its code point, a WCHAR the one-character STRING ('?' when CP1252 lacks it),
// a STRING's first character the WCHAR and a WSTRING's first unit the CHAR.
inline IECWString<254> TO_WSTRING(CHAR_t c) noexcept { return TO_WSTRING(TO_WCHAR(c).get()); }
inline IECWString<254> TO_WSTRING(const IEC_CHAR& c) noexcept { return TO_WSTRING(c.get()); }
inline IECString<254> TO_STRING(WCHAR_t c) noexcept { return TO_STRING(TO_CHAR(c).get()); }
inline IECString<254> TO_STRING(const IEC_WCHAR& c) noexcept { return TO_STRING(c.get()); }
template<size_t N> inline IEC_WCHAR TO_WCHAR(const IECString<N>& s) noexcept {
    return TO_WCHAR(s.length() > 0 ? s.c_str()[0] : '\0');
}
template<size_t N> inline IEC_WCHAR TO_WCHAR(const IECStringVar<N>& s) noexcept { return TO_WCHAR(s.get()); }
template<size_t N> inline IEC_CHAR TO_CHAR(const IECWString<N>& s) noexcept {
    return TO_CHAR(static_cast<WCHAR_t>(s.length() > 0 ? s[0] : u'\0'));
}
template<size_t N> inline IEC_CHAR TO_CHAR(const IECWStringVar<N>& s) noexcept { return TO_CHAR(s.get()); }
// A STRING or WSTRING literal argument: its first character (0 when empty).
inline IEC_CHAR TO_CHAR(const char* s) noexcept { return IEC_CHAR(s[0]); }
inline IEC_CHAR TO_CHAR(const char16_t* s) noexcept { return TO_CHAR(static_cast<WCHAR_t>(s[0])); }
inline IEC_WCHAR TO_WCHAR(const char* s) noexcept { return TO_WCHAR(static_cast<CHAR_t>(s[0])); }
inline IEC_WCHAR TO_WCHAR(const char16_t* s) noexcept { return IEC_WCHAR(static_cast<WCHAR_t>(s[0])); }

// =============================================================================
// WSTRING → Numeric Conversions
// =============================================================================
//
// IEC 61131-3: WSTRING_TO_INT / WSTRING_TO_REAL / etc. all route through
// WSTRING_TO_STRING (lossy narrow-to-ASCII; same caveat the standard
// transcoding helpers document) and then reuse the STRING parsers
// already defined in iec_string.hpp.  This keeps the parsing semantics
// (strtoul / strtol / strtod) byte-identical between the STRING and
// WSTRING surfaces, and the narrow conversion is correct for the
// numeric ASCII / Latin-1 subset users actually write into STRING
// literals.

template<size_t N>
inline IEC_BOOL TO_BOOL(const IECWString<N>& s) noexcept {
    return TO_BOOL(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_BOOL TO_BOOL(const IECWStringVar<N>& s) noexcept {
    return TO_BOOL(s.get());
}

template<size_t N>
inline IEC_SINT TO_SINT(const IECWString<N>& s) noexcept {
    return TO_SINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_SINT TO_SINT(const IECWStringVar<N>& s) noexcept {
    return TO_SINT(s.get());
}

template<size_t N>
inline IEC_INT TO_INT(const IECWString<N>& s) noexcept {
    return TO_INT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_INT TO_INT(const IECWStringVar<N>& s) noexcept {
    return TO_INT(s.get());
}

template<size_t N>
inline IEC_DINT TO_DINT(const IECWString<N>& s) noexcept {
    return TO_DINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_DINT TO_DINT(const IECWStringVar<N>& s) noexcept {
    return TO_DINT(s.get());
}

template<size_t N>
inline IEC_LINT TO_LINT(const IECWString<N>& s) noexcept {
    return TO_LINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_LINT TO_LINT(const IECWStringVar<N>& s) noexcept {
    return TO_LINT(s.get());
}

template<size_t N>
inline IEC_USINT TO_USINT(const IECWString<N>& s) noexcept {
    return TO_USINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_USINT TO_USINT(const IECWStringVar<N>& s) noexcept {
    return TO_USINT(s.get());
}

template<size_t N>
inline IEC_UINT TO_UINT(const IECWString<N>& s) noexcept {
    return TO_UINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_UINT TO_UINT(const IECWStringVar<N>& s) noexcept {
    return TO_UINT(s.get());
}

template<size_t N>
inline IEC_UDINT TO_UDINT(const IECWString<N>& s) noexcept {
    return TO_UDINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_UDINT TO_UDINT(const IECWStringVar<N>& s) noexcept {
    return TO_UDINT(s.get());
}

template<size_t N>
inline IEC_ULINT TO_ULINT(const IECWString<N>& s) noexcept {
    return TO_ULINT(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_ULINT TO_ULINT(const IECWStringVar<N>& s) noexcept {
    return TO_ULINT(s.get());
}

template<size_t N>
inline IEC_REAL TO_REAL(const IECWString<N>& s) noexcept {
    return TO_REAL(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_REAL TO_REAL(const IECWStringVar<N>& s) noexcept {
    return TO_REAL(s.get());
}

template<size_t N>
inline IEC_LREAL TO_LREAL(const IECWString<N>& s) noexcept {
    return TO_LREAL(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_LREAL TO_LREAL(const IECWStringVar<N>& s) noexcept {
    return TO_LREAL(s.get());
}

template<size_t N>
inline IEC_BYTE TO_BYTE(const IECWString<N>& s) noexcept {
    return TO_BYTE(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_BYTE TO_BYTE(const IECWStringVar<N>& s) noexcept {
    return TO_BYTE(s.get());
}

template<size_t N>
inline IEC_WORD TO_WORD(const IECWString<N>& s) noexcept {
    return TO_WORD(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_WORD TO_WORD(const IECWStringVar<N>& s) noexcept {
    return TO_WORD(s.get());
}

template<size_t N>
inline IEC_DWORD TO_DWORD(const IECWString<N>& s) noexcept {
    return TO_DWORD(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_DWORD TO_DWORD(const IECWStringVar<N>& s) noexcept {
    return TO_DWORD(s.get());
}

template<size_t N>
inline IEC_LWORD TO_LWORD(const IECWString<N>& s) noexcept {
    return TO_LWORD(WSTRING_TO_STRING(s));
}
template<size_t N>
inline IEC_LWORD TO_LWORD(const IECWStringVar<N>& s) noexcept {
    return TO_LWORD(s.get());
}

// =============================================================================
// Time Utilities
// =============================================================================

/** A TIME from milliseconds, modulo 2^32. */
inline IEC_TIME TIME_FROM_MS(int64_t ms) noexcept {
    return IEC_TIME(TIME_t(static_cast<uint32_t>(static_cast<uint64_t>(ms))));
}

/** A TIME from seconds, truncated to ms, modulo 2^32. */
inline IEC_TIME TIME_FROM_S(double s) noexcept {
    return TIME_FROM_MS(static_cast<int64_t>(s * 1000.0));
}

/** The milliseconds of a TIME (or an LTIME, truncated). */
inline int64_t TIME_TO_MS(IEC_TIME t) noexcept { return static_cast<int64_t>(t.get().raw); }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline int64_t TIME_TO_MS(const IECVar<L_>& t) noexcept { return iec_unwrap(t) / 1000000; }

/** The seconds of a TIME (or an LTIME), the fraction kept. */
inline double TIME_TO_S(IEC_TIME t) noexcept { return static_cast<double>(t.get().raw) / 1000.0; }
template<typename L_, std::enable_if_t<std::is_same<L_, int64_t>::value, int> = 0>
inline double TIME_TO_S(const IECVar<L_>& t) noexcept { return static_cast<double>(iec_unwrap(t)) / 1000000000.0; }

// =============================================================================
// Variadic Arithmetic Functions (ANY_NUM -> ANY_NUM)
// =============================================================================

/**
 * NEG - Negation (unary minus)
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 */
template<typename T, enable_if_any_num<T> = 0>
inline T NEG(T value) noexcept {
    return T(-iec_unwrap(value));
}

/**
 * ADD - Addition (variadic)
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 * Adds two or more values together
 */
template<typename T, enable_if_any_num<T> = 0>
inline T ADD(T a, T b) noexcept {
    return T(iec_unwrap(a) + iec_unwrap(b));
}

template<typename T, typename... Args, enable_if_any_num<T> = 0>
inline T ADD(T first, T second, Args... rest) noexcept {
    return ADD(T(iec_unwrap(first) + iec_unwrap(second)), rest...);
}

/**
 * MUL - Multiplication (variadic)
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 * Multiplies two or more values together
 */
template<typename T, enable_if_any_num<T> = 0>
inline T MUL(T a, T b) noexcept {
    return T(iec_unwrap(a) * iec_unwrap(b));
}

template<typename T, typename... Args, enable_if_any_num<T> = 0>
inline T MUL(T first, T second, Args... rest) noexcept {
    return MUL(T(iec_unwrap(first) * iec_unwrap(second)), rest...);
}

/**
 * SUB - Subtraction
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 * Subtracts second value from first
 */
template<typename T, enable_if_any_num<T> = 0>
inline T SUB(T a, T b) noexcept {
    return T(iec_unwrap(a) - iec_unwrap(b));
}

/**
 * DIV - Division
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 * Divides first value by second
 */
template<typename T, enable_if_any_num<T> = 0>
inline T DIV(T a, T b) noexcept {
    return T(iec_unwrap(a) / iec_unwrap(b));
}

/**
 * MOD - Modulo
 * Input: ANY_NUM, Output: ANY_NUM (same type)
 * Returns remainder of division
 */
namespace detail {
template<typename T>
inline T iec_mod_impl(T a, T b, std::true_type /*floating*/) noexcept {
    return T(std::fmod(static_cast<double>(iec_unwrap(a)), static_cast<double>(iec_unwrap(b))));
}
template<typename T>
inline T iec_mod_impl(T a, T b, std::false_type) noexcept {
    return iec_unwrap(b) == 0 || ::strucpp::iec_mod_minus_one(iec_unwrap(b))
        ? T(0)
        : T(iec_unwrap(a) % iec_unwrap(b));
}
}  // namespace detail

template<typename T, enable_if_any_num<T> = 0>
inline T MOD(T a, T b) noexcept {
    return detail::iec_mod_impl(
        a, b,
        std::integral_constant<bool,
            std::is_floating_point<iec_underlying_type_t<T>>::value>{});
}

/**
 * A store into a subrange variable: the value, or a run-time fault naming the
 * variable, the value and the range when it is outside `lo..hi`.
 */
namespace detail {
/** `a < b` for any two integers, compared by value: an unsigned above 2^63 is not negative. */
template<typename A, typename B>
constexpr bool subrange_below(A a, B b) noexcept {
    return (a < static_cast<A>(0)) != (b < static_cast<B>(0))
        ? a < static_cast<A>(0)
        : static_cast<unsigned long long>(a) < static_cast<unsigned long long>(b);
}

/** Raise the subrange fault for `v` outside `lo..hi`, each written as its value. */
template<typename X, typename T>
[[noreturn]] STRUCPP_FAULT_PATH void subrange_fault(X v, T lo, T hi, const char* name, iec_site site) {
    fault_text text;
    text.add("Value ").add_number(v).add(" outside ").add_number(lo).add("..").add_number(hi);
    text.add(" stored in ").add(name);
    iec_raise_fault(IecFault::Subrange, text, site);
}
}  // namespace detail

template<typename T, typename V>
inline T iec_subrange_store(const V& value, T lo, T hi, const char* name, iec_site site) {
    const auto v = iec_unwrap(value);
#ifndef STRUCPP_NO_BOUNDS_CHECK
    if (detail::subrange_below(v, lo) || detail::subrange_below(hi, v)) {
        detail::subrange_fault(v, lo, hi, name, site);
    }
#else
    (void)lo; (void)hi; (void)name; (void)site;
#endif
    return static_cast<T>(v);
}

/**
 * Integer `/` whose divisor may be 0: a division by zero is a run-time fault
 * naming the POU, line and task; the minimum value / -1 wraps instead of trapping.
 */
template<typename A, typename B>
inline auto iec_div(const A& a, const B& b, iec_site site) -> decltype(a / b) {
    using Result = decltype(a / b);
    const auto av = iec_unwrap(a) + 0;
    const auto bv = iec_unwrap(b) + 0;
    using C = decltype(av / bv);
    if (bv == 0) iec_site_fault(IecFault::DivideByZero, "Division by zero", site);
    if (::strucpp::iec_mod_minus_one(bv)) {
        return Result(static_cast<C>(
            static_cast<std::make_unsigned_t<C>>(0) -
            static_cast<std::make_unsigned_t<C>>(av)));
    }
    return a / b;
}

namespace detail {
template<int K>
constexpr bool temporal_zero(IecTemporal32<K> v) noexcept { return v.raw == 0u; }
template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
constexpr bool temporal_zero(N v) noexcept { return v == 0; }
}  // namespace detail

/**
 * A TIME, DATE, TOD or DT `/` a number or a duration (DIV_TIME too): a zero
 * divisor is a run-time fault naming the POU, line and task, as for integers.
 */
template<typename A, typename N>
inline auto iec_temporal_div(const A& a, const N& n, iec_site site)
    -> decltype(iec_unwrap(a) / iec_unwrap(n)) {
    const auto d = iec_unwrap(n);
    if (detail::temporal_zero(d)) iec_site_fault(IecFault::DivideByZero, "Division by zero", site);
    return iec_unwrap(a) / d;
}

/** A TIME, DATE, TOD or DT MOD an integer or a duration: unsigned 32-bit; MOD 0 gives 0. */
template<typename A, typename N>
inline auto iec_temporal_mod(const A& a, const N& n) -> decltype(iec_unwrap(a) % iec_unwrap(n)) {
    return iec_unwrap(a) % iec_unwrap(n);
}

/** A TOD or DT MOD a TIME: the time within that period, in the instant's type (iec_mod_period). */
template<typename A, typename P>
inline auto iec_temporal_mod_period(const A& a, const P& p) -> decltype(iec_mod_period(iec_unwrap(a), iec_unwrap(p))) {
    return iec_mod_period(iec_unwrap(a), iec_unwrap(p));
}


/** DIVTIME(a, b), a duration by a duration: b = 0 is a run-time fault, as for integers. */
template<typename A, typename B>
inline auto iec_divtime(const A& a, const B& b, iec_site site) -> decltype(DIVTIME(a, b)) {
    if (detail::temporal_zero(iec_unwrap(b))) {
        iec_site_fault(IecFault::DivideByZero, "Division by zero", site);
    }
    return DIVTIME(a, b);
}

/**
 * Binary MOD operator: OUT is 0 when IN2 is 0 (IEC 61131-3 Table 29, note e).
 * The result type is the one the C++ % operator gives for the operands.
 */
template<typename A, typename B>
constexpr auto iec_mod(const A& a, const B& b) -> decltype(a % b) {
    return b == 0 || ::strucpp::iec_mod_minus_one(b + 0) ? decltype(a % b)(0) : a % b;
}

// =============================================================================
// Variadic Bitwise Functions (ANY_BIT -> ANY_BIT)
// =============================================================================

/**
 * NOT - Bitwise NOT (one's complement)
 * Input: ANY_BIT, Output: ANY_BIT (same type)
 *
 * BOOL needs logical negation, not bitwise: `~bool(true)` integer-promotes
 * to `~1 == -2`, and converting back via `bool(-2)` is `true` (any non-zero
 * is true), so the bitwise path returns `true` for both inputs. The
 * IEC_BOOL specialization handles wrapped booleans, but expressions like
 * `NOT(a == b)` instantiate the primary template with `T = bool` (raw)
 * because IECVar's comparison operators return plain `bool`. Add a
 * raw-bool specialization that uses `!` so NOT(comparison) works.
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T NOT(T value) noexcept {
    return T(~iec_unwrap(value));
}

template<>
inline bool NOT(bool value) noexcept {
    return !value;
}

template<>
inline IEC_BOOL NOT(IEC_BOOL value) noexcept {
    return IEC_BOOL(!iec_unwrap(value));
}

/**
 * AND - Bitwise AND (variadic)
 * Input: ANY_BIT, Output: ANY_BIT (same type)
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T AND(T a, T b) noexcept {
    return T(iec_unwrap(a) & iec_unwrap(b));
}

template<typename T, typename... Args, enable_if_any_bit<T> = 0>
inline T AND(T first, T second, Args... rest) noexcept {
    return AND(T(iec_unwrap(first) & iec_unwrap(second)), rest...);
}

/**
 * OR - Bitwise OR (variadic)
 * Input: ANY_BIT, Output: ANY_BIT (same type)
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T OR(T a, T b) noexcept {
    return T(iec_unwrap(a) | iec_unwrap(b));
}

template<typename T, typename... Args, enable_if_any_bit<T> = 0>
inline T OR(T first, T second, Args... rest) noexcept {
    return OR(T(iec_unwrap(first) | iec_unwrap(second)), rest...);
}

/**
 * XOR - Bitwise XOR (variadic)
 * Input: ANY_BIT, Output: ANY_BIT (same type)
 */
template<typename T, enable_if_any_bit<T> = 0>
inline T XOR(T a, T b) noexcept {
    return T(iec_unwrap(a) ^ iec_unwrap(b));
}

template<typename T, typename... Args, enable_if_any_bit<T> = 0>
inline T XOR(T first, T second, Args... rest) noexcept {
    return XOR(T(iec_unwrap(first) ^ iec_unwrap(second)), rest...);
}

// =============================================================================
// Variadic Selection Functions (ANY_ELEMENTARY)
// =============================================================================

/**
 * MAX - Maximum (variadic)
 * Input: ANY_ELEMENTARY, Output: ANY_ELEMENTARY (same type)
 * Returns the maximum of two or more values
 */
// Three-or-more arguments only; the two-argument base case is defined above.
// Recursion instead of `if constexpr (sizeof...(rest) > 0)`, which is C++17.
// `third` keeps its own type so the recursion still reaches the mixed-type
// two-argument overload — OSCAT passes INT and DINT to the same call.
template<typename T, typename U, typename... Args, enable_if_any_elementary<T> = 0>
inline auto MAX(T first, T second, U third, Args... rest) noexcept {
    return MAX(MAX(first, second), third, rest...);
}

/**
 * MIN - Minimum (variadic)
 * Input: ANY_ELEMENTARY, Output: ANY_ELEMENTARY (same type)
 * Returns the minimum of two or more values
 */
// Three-or-more arguments only; the two-argument base case is defined above.
// Recursion instead of `if constexpr (sizeof...(rest) > 0)`, which is C++17.
// `third` keeps its own type so the recursion still reaches the mixed-type
// two-argument overload — OSCAT passes INT and DINT to the same call.
template<typename T, typename U, typename... Args, enable_if_any_elementary<T> = 0>
inline auto MIN(T first, T second, U third, Args... rest) noexcept {
    return MIN(MIN(first, second), third, rest...);
}

/**
 * MOVE - Copy value (identity function)
 * Input: ANY, Output: ANY (same type)
 * Used for explicit value copying in ST
 */
template<typename T>
inline T MOVE(T value) noexcept {
    return value;
}

// =============================================================================
// Scan-Cycle Time (CODESYS/MatIEC-compatible)
// =============================================================================

/**
 * Global scan-cycle time in nanoseconds.
 * Advanced by the runtime before each scan cycle.
 * - REPL advances by common_ticktime each cycle.
 * - OpenPLC runtime advances before each task execution.
 * - Test runner resets to 0 before each test case.
 *
 * All calls to TIME() within the same cycle return the same value,
 * matching CODESYS behavior.
 */
#ifdef STRUCPP_THREADED
// Threaded runtime (OpenPLC v4): each IEC task runs on its own thread and must
// observe an IEC TIME() value that is STABLE for the duration of its scan and
// equal to the time at which the dispatcher released it. thread_local gives
// every worker its own TIME() base; the runtime stamps it via
// strucpp_set_current_time() at each dispatch, so a slow/overrunning task keeps
// reading its own snapshot while the dispatcher's master clock advances freely
// for the other tasks. Gated on STRUCPP_THREADED because single-threaded
// targets (Arduino/bare-metal) may have no TLS runtime — there it stays a plain
// global, which is correct for a one-thread scan loop.
inline int64_t& __current_time_ns_slot() {
    static thread_local int64_t slot = 0;
    return slot;
}
static thread_local int64_t& __CURRENT_TIME_NS = __current_time_ns_slot();
#else
// One slot shared by every translation unit, reached through a reference so
// every existing use site still reads and writes the plain name. A header-scope
// `inline` variable would say this in one line, but that is C++17 and the
// runtime targets C++14.
inline int64_t& __current_time_ns_slot() {
    static int64_t slot = 0;
    return slot;
}
static int64_t& __CURRENT_TIME_NS = __current_time_ns_slot();
#endif

/**
 * Returns the current scan-cycle time.
 * CODESYS-compatible: TIME() returns the same value for the entire cycle.
 */
inline IEC_TIME TIME() {
    return IEC_TIME(TIME_OF_NS(__CURRENT_TIME_NS));
}

/** A duration as nanoseconds: a TIME by its meaning, an LTIME or a count as is. */
template<typename T, std::enable_if_t<std::is_arithmetic<T>::value, int> = 0>
inline int64_t iec_duration_ns(T v) noexcept { return static_cast<int64_t>(v); }
inline int64_t iec_duration_ns(TIME_t v) noexcept { return TIME_AS_NS(v); }
template<typename T>
inline int64_t iec_duration_ns(const IECVar<T>& v) noexcept { return iec_duration_ns(v.get()); }

/** The scan-cycle time as an LTIME (64-bit ns, no wrap): for LTON, LTOF, LTP. */
inline IEC_LTIME LTIME() {
    return IEC_LTIME(static_cast<LTIME_t>(__CURRENT_TIME_NS));
}

/**
 * Wall-clock date-and-time override slot, in nanoseconds since the
 * Unix epoch.
 *
 * Platform integrations that *can* deliver real wall-clock time
 * (VPP packages with a DS3231 RTC chip wired up, Wi-Fi targets that
 * pull NTP, etc.) populate this before each scan and CURRENT_DT()
 * returns it verbatim. Targets without that capability leave it at 0
 * and CURRENT_DT() falls back to a meaningful-but-not-wall-clock
 * value — see the function comment for the full priority order.
 */
inline int64_t& __current_dt_ns_slot() {
    static int64_t slot = 0;
    return slot;
}
static int64_t& __CURRENT_DT_NS = __current_dt_ns_slot();

/**
 * CURRENT_DT() — wall-clock date-and-time.
 *
 * Returns the current absolute time as IEC_DT (nanoseconds since the
 * Unix epoch). Distinct from TIME() which returns the scan-cycle's
 * monotonic elapsed time, not a date.
 *
 * Resolution priority (highest first):
 *   1. `__CURRENT_DT_NS` when non-zero — the platform integration
 *      delivered a real wall-clock value (RTC chip, NTP, host syscall
 *      wired by an OpenPLC v4 runtime, etc.). Honoured on every
 *      target.
 *   2. std::chrono::system_clock on hosted targets — covers REPL, test
 *      runner, and any g++ build that didn't populate
 *      `__CURRENT_DT_NS`. Inherits CLOCK_REALTIME's quirks (can step
 *      backwards if the system clock is corrected); code needing
 *      strict monotonicity should use TIME() instead.
 *   3. `__CURRENT_TIME_NS` (time since program start) on bare-metal
 *      targets where std::chrono::system_clock isn't available.
 *      avr-gcc's libstdc++ ships `<chrono>` but omits `system_clock`,
 *      so we can't reach for it on Arduino / AVR. Returning uptime
 *      keeps the IEC_DT value monotonically advancing — programs that
 *      diff two CURRENT_DT() readings still see meaningful elapsed
 *      time, just expressed in seconds-since-boot rather than seconds-
 *      since-1970.
 *
 * VPP packages targeting hardware with an RTC override (1) by writing
 * `__CURRENT_DT_NS` from their platform glue. Nothing else in the
 * runtime needs to change to enable that path.
 */
inline IEC_DT CURRENT_DT() {
    if (__CURRENT_DT_NS != 0) {
        return IEC_DT(DT_OF_NS(__CURRENT_DT_NS));
    }
#ifdef __AVR__
    // No system_clock on avr-gcc. `__CURRENT_TIME_NS` advances
    // monotonically as the runtime drives the scan cycle, giving us
    // time-since-boot — meaningful for diffing timestamps even when
    // no RTC is wired up.
    return IEC_DT(DT_OF_NS(__CURRENT_TIME_NS));
#else
    using namespace std::chrono;
    auto now = system_clock::now();
    auto ns  = duration_cast<nanoseconds>(now.time_since_epoch()).count();
    return IEC_DT(DT_OF_NS(static_cast<int64_t>(ns)));
#endif
}

// =============================================================================
// CODESYS System Functions
// =============================================================================

/**
 * ADR(variable) - Returns the memory address of a variable.
 * CODESYS extension. Maps to address-of in C++, returning uintptr_t
 * for compatibility with pointer arithmetic.
 */
template<typename T>
inline IEC_ULINT ADR(T& var) {
    return static_cast<IEC_ULINT>(reinterpret_cast<std::uintptr_t>(&var));
}

/**
 * IEC_SIZEOF(var) - Returns the logical IEC type size in bytes.
 * For IECVar<T> types, returns sizeof(T) (the underlying type),
 * not sizeof(IECVar<T>) which includes the forcing wrapper overhead.
 * Matches CODESYS SIZEOF behavior: SIZEOF(INT) = 2, SIZEOF(DINT) = 4, etc.
 */
template<typename T>
inline IEC_UDINT IEC_SIZEOF(const IECVar<T>&) noexcept {
    return static_cast<IEC_UDINT>(sizeof(T));
}
template<typename T>
inline IEC_UDINT IEC_SIZEOF(const T&) noexcept {
    return static_cast<IEC_UDINT>(sizeof(T));
}

/** SIZEOF of a type name: the size IEC_SIZEOF gives a value of `T`, with no value built. */
template<typename T>
struct iec_size_of_type {
    static constexpr UDINT_t value = static_cast<UDINT_t>(sizeof(T));
};
template<typename T>
struct iec_size_of_type<IECVar<T>> {
    static constexpr UDINT_t value = static_cast<UDINT_t>(sizeof(T));
};

/**
 * MEMCPY(dest, src, n) - Copies n bytes from src to dest.
 * CODESYS extension. Accepts uintptr_t addresses from ADR() for
 * pointer arithmetic compatibility.
 */
inline IEC_ULINT MEMCPY(IEC_ULINT dest, IEC_ULINT src, std::size_t n) {
    std::memcpy(reinterpret_cast<void*>(static_cast<std::uintptr_t>(dest)),
                reinterpret_cast<const void*>(static_cast<std::uintptr_t>(src)), n);
    return dest;
}

} // namespace strucpp
