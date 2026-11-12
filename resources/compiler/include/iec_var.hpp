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
//     (see the guarded <concepts> block in iec_types.hpp for the pattern).
//
// Boundary introduced in commit be85d8a. If you change which headers
// `c_blocks_code.cpp` pulls in, update this set of warnings accordingly.
// ============================================================================
/**
 * STruC++ Runtime - IEC Variable Wrapper
 *
 * This header defines the IECVar template class that wraps IEC types: one
 * member, laid out as the value itself. Forcing is held in the force table
 * (iec_force.hpp), beside the variable.
 *
 * Located variables (AT %IX0.0, etc.) use this same wrapper, and the
 * raw_ptr() method provides access to the underlying storage for
 * runtime binding to I/O image tables.
 */

#pragma once

#include "iec_types.hpp"
#include <type_traits>
#include <utility>

namespace strucpp {

// Forward declaration for pointer-to-integer assignment
template<typename T> class IEC_Ptr;

// =============================================================================
// IEC Variable Wrapper
// =============================================================================

/**
 * Template wrapper for IEC variables.
 *
 * The wrapper is exactly its value: one member, the size and alignment of T,
 * standard layout and trivially copyable, so a variable is laid out in memory
 * as on a PLC and a POINTER TO of another shape reads its real bytes. Forcing
 * is held beside the variable in the force table (iec_force.hpp).
 *
 * This class wraps any IEC type and provides:
 * - Normal get/set operations
 * - Implicit conversion for natural syntax
 * - Arithmetic operators for numeric types
 *
 * @tparam T The underlying C++ type (e.g., int16_t for INT)
 */
template<typename T>
class STRUCPP_MAY_ALIAS IECVar {
public:
    using value_type = T;

    // =========================================================================
    // Constructors
    // =========================================================================

    /** Default constructor - initializes to zero/false */
    IECVar() noexcept : value_{} {}

    /** Construct with initial value (non-explicit to allow IEC_INT val = 10 syntax) */
    IECVar(T v) noexcept : value_{v} {}

    /** Cross-type converting constructor: IECVar<SINT_t> → IECVar<INT_t> etc.
     *  Enables implicit widening when struct fields (now IECVar-wrapped) are passed
     *  to functions expecting a wider IECVar type. Without this, C++ would need
     *  two user-defined conversions (IECVar<U>→U→T→IECVar<T>) which is disallowed. */
    template<typename U, std::enable_if_t<
        std::is_convertible<U, T>::value && !std::is_same<U, T>::value, int> = 0>
    IECVar(const IECVar<U>& other) noexcept
        : value_{static_cast<T>(other.get())} {}

    /** Copies are plain value copies: a force is keyed by address, so a copy
     *  neither carries one nor clears one. */
    IECVar(const IECVar&) = default;
    IECVar(IECVar&&) = default;
    IECVar& operator=(const IECVar&) = default;
    IECVar& operator=(IECVar&&) = default;

    // =========================================================================
    // Value Access
    // =========================================================================

    /** Get the current value. */
    T get() const noexcept {
        return value_;
    }

    /** Set the value. */
    void set(T v) noexcept {
        value_ = v;
    }

    // =========================================================================
    // Raw Pointer Access (for Located Variables)
    // =========================================================================

    /**
     * Get a pointer to the underlying raw storage.
     * Used by the runtime to bind located variables to I/O image tables.
     * Plugins and drivers read/write through this pointer.
     *
     * A forced located variable is written through the same storage by the
     * force table at cycle boundaries, so drivers see the forced value.
     */
    T* raw_ptr() noexcept { return &value_; }

    /**
     * Get a const pointer to the underlying raw storage.
     */
    const T* raw_ptr() const noexcept { return &value_; }

    // =========================================================================
    // Implicit Conversions
    // =========================================================================

    /** Implicit conversion to underlying type for natural syntax */
    operator T() const noexcept {
        return get();
    }

    /** Assignment from raw value */
    IECVar& operator=(T v) noexcept {
        set(v);
        return *this;
    }

    /** Cross-type assignment: IECVar<SINT_t> → IECVar<INT_t> etc.
     *  Resolves ambiguity when assigning between different IECVar specializations
     *  by providing a direct match (template is preferred over two indirect paths
     *  that each require one user-defined conversion). */
    template<typename U, std::enable_if_t<
        std::is_convertible<U, T>::value && !std::is_same<U, T>::value, int> = 0>
    IECVar& operator=(const IECVar<U>& other) noexcept {
        set(static_cast<T>(other.get()));
        return *this;
    }

    /** Assignment from IEC_Ptr (CODESYS: DWORD_VAR := PT stores address as integer).
     *  WARNING: On 64-bit platforms, assigning to types narrower than pointer width
     *  (e.g., DWORD) truncates the address. Use ULINT, LWORD, or PTR_INT_t for
     *  portable pointer-to-integer storage. */
    template<typename U, typename V = T, std::enable_if_t<std::is_integral<V>::value, int> = 0>
    IECVar& operator=(const IEC_Ptr<U>& ptr) noexcept {
        set(static_cast<T>(ptr.to_addr()));
        return *this;
    }

    /** Assignment from a raw pointer — stores the address as an integer.
     *  Used by the ADR(x) lowering `_TMP : __XWORD := &(x)`. Integral targets
     *  only; routed through uintptr_t so it is pointer-width-correct per
     *  target (no truncation when T is __XWORD/XWORD_t). */
    template<typename U, typename V = T, std::enable_if_t<std::is_integral<V>::value, int> = 0>
    IECVar& operator=(U* p) noexcept {
        set(static_cast<T>(reinterpret_cast<std::uintptr_t>(p)));
        return *this;
    }

    // =========================================================================
    // Container Access Forwarding (for array/struct types)
    // =========================================================================

    /** Forward operator-> to underlying type (struct/FB member access) */
    template<typename U = T, std::enable_if_t<std::is_class<U>::value, int> = 0>
    T* operator->() noexcept { return &value_; }

    template<typename U = T, std::enable_if_t<std::is_class<U>::value, int> = 0>
    const T* operator->() const noexcept { return &value_; }

    /** Forward operator[] to underlying type (1D array access) */
    template<typename Index>
    auto operator[](Index i) noexcept -> decltype(std::declval<T&>()[i]) {
        return value_[i];
    }

    template<typename Index>
    auto operator[](Index i) const noexcept -> decltype(std::declval<const T&>()[i]) {
        return value_[i];
    }

    /** Forward operator() to underlying type (2D+ array access) */
    template<typename... Args>
    auto operator()(Args... args) noexcept -> decltype(std::declval<T&>()(args...)) {
        return value_(args...);
    }

    template<typename... Args>
    auto operator()(Args... args) const noexcept -> decltype(std::declval<const T&>()(args...)) {
        return value_(args...);
    }

    // =========================================================================
    // Arithmetic Operators
    // =========================================================================

    IECVar& operator+=(T v) noexcept {
        set(get() + v);
        return *this;
    }

    IECVar& operator-=(T v) noexcept {
        set(get() - v);
        return *this;
    }

    IECVar& operator*=(T v) noexcept {
        set(get() * v);
        return *this;
    }

    IECVar& operator/=(T v) noexcept {
        set(get() / v);
        return *this;
    }

    IECVar& operator%=(T v) noexcept {
        set(get() % v);
        return *this;
    }

    // Prefix increment
    IECVar& operator++() noexcept {
        set(get() + 1);
        return *this;
    }

    // Postfix increment
    IECVar operator++(int) noexcept {
        IECVar tmp = *this;
        ++(*this);
        return tmp;
    }

    // Prefix decrement
    IECVar& operator--() noexcept {
        set(get() - 1);
        return *this;
    }

    // Postfix decrement
    IECVar operator--(int) noexcept {
        IECVar tmp = *this;
        --(*this);
        return tmp;
    }

    // =========================================================================
    // Bitwise Operators (for bit string types)
    // =========================================================================

    IECVar& operator&=(T v) noexcept {
        set(get() & v);
        return *this;
    }

    IECVar& operator|=(T v) noexcept {
        set(get() | v);
        return *this;
    }

    IECVar& operator^=(T v) noexcept {
        set(get() ^ v);
        return *this;
    }

private:
    T value_;           ///< The value; the only member
};

// =============================================================================
// Binary Operators
// =============================================================================

template<typename T>
inline IECVar<T> operator+(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() + b.get());
}

template<typename T>
inline IECVar<T> operator-(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() - b.get());
}

template<typename T>
inline IECVar<T> operator*(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() * b.get());
}

template<typename T>
inline IECVar<T> operator/(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() / b.get());
}

template<typename T, typename = std::enable_if_t<std::is_integral<T>::value>>
inline IECVar<T> operator%(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() % b.get());
}

// Mixed-type arithmetic operators (IECVar<T> op T) and (T op IECVar<T>)
template<typename T> inline IECVar<T> operator+(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() + b); }
template<typename T> inline IECVar<T> operator+(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a + b.get()); }
template<typename T> inline IECVar<T> operator-(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() - b); }
template<typename T> inline IECVar<T> operator-(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a - b.get()); }
template<typename T> inline IECVar<T> operator*(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() * b); }
template<typename T> inline IECVar<T> operator*(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a * b.get()); }
template<typename T> inline IECVar<T> operator/(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() / b); }
template<typename T> inline IECVar<T> operator/(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a / b.get()); }
template<typename T, typename = std::enable_if_t<std::is_integral<T>::value>> inline IECVar<T> operator%(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() % b); }
template<typename T, typename = std::enable_if_t<std::is_integral<T>::value>> inline IECVar<T> operator%(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a % b.get()); }

// =============================================================================
// Comparison Operators
// =============================================================================

template<typename T>
inline bool operator==(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() == b.get();
}

template<typename T>
inline bool operator!=(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() != b.get();
}

template<typename T>
inline bool operator<(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() < b.get();
}

template<typename T>
inline bool operator>(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() > b.get();
}

template<typename T>
inline bool operator<=(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() <= b.get();
}

template<typename T>
inline bool operator>=(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() >= b.get();
}

// Mixed-type comparison operators
template<typename T> inline bool operator==(const IECVar<T>& a, T b) noexcept { return a.get() == b; }
template<typename T> inline bool operator==(T a, const IECVar<T>& b) noexcept { return a == b.get(); }
template<typename T> inline bool operator!=(const IECVar<T>& a, T b) noexcept { return a.get() != b; }
template<typename T> inline bool operator!=(T a, const IECVar<T>& b) noexcept { return a != b.get(); }
template<typename T> inline bool operator<(const IECVar<T>& a, T b) noexcept { return a.get() < b; }
template<typename T> inline bool operator<(T a, const IECVar<T>& b) noexcept { return a < b.get(); }
template<typename T> inline bool operator>(const IECVar<T>& a, T b) noexcept { return a.get() > b; }
template<typename T> inline bool operator>(T a, const IECVar<T>& b) noexcept { return a > b.get(); }
template<typename T> inline bool operator<=(const IECVar<T>& a, T b) noexcept { return a.get() <= b; }
template<typename T> inline bool operator<=(T a, const IECVar<T>& b) noexcept { return a <= b.get(); }
template<typename T> inline bool operator>=(const IECVar<T>& a, T b) noexcept { return a.get() >= b; }
template<typename T> inline bool operator>=(T a, const IECVar<T>& b) noexcept { return a >= b.get(); }

// =============================================================================
// Bitwise Operators
// =============================================================================

template<typename T>
inline IECVar<T> operator&(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() & b.get());
}

template<typename T>
inline IECVar<T> operator|(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() | b.get());
}

template<typename T>
inline IECVar<T> operator^(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return IECVar<T>(a.get() ^ b.get());
}

// Mixed-type bitwise operators
template<typename T> inline IECVar<T> operator&(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() & b); }
template<typename T> inline IECVar<T> operator&(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a & b.get()); }
template<typename T> inline IECVar<T> operator|(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() | b); }
template<typename T> inline IECVar<T> operator|(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a | b.get()); }
template<typename T> inline IECVar<T> operator^(const IECVar<T>& a, T b) noexcept { return IECVar<T>(a.get() ^ b); }
template<typename T> inline IECVar<T> operator^(T a, const IECVar<T>& b) noexcept { return IECVar<T>(a ^ b.get()); }

template<typename T>
inline IECVar<T> operator~(const IECVar<T>& a) noexcept {
    return IECVar<T>(~a.get());
}

// =============================================================================
// IEC Type Aliases
// =============================================================================

// Boolean
using IEC_BOOL = IECVar<BOOL_t>;

// Bit strings
using IEC_BYTE = IECVar<BYTE_t>;
using IEC_WORD = IECVar<WORD_t>;
using IEC_DWORD = IECVar<DWORD_t>;
using IEC_LWORD = IECVar<LWORD_t>;
// CODESYS __XWORD — pointer-width unsigned (see XWORD_t in iec_types.hpp).
using IEC_XWORD = IECVar<XWORD_t>;

// Signed integers
using IEC_SINT = IECVar<SINT_t>;
using IEC_INT = IECVar<INT_t>;
using IEC_DINT = IECVar<DINT_t>;
using IEC_LINT = IECVar<LINT_t>;

// Unsigned integers
using IEC_USINT = IECVar<USINT_t>;
using IEC_UINT = IECVar<UINT_t>;
using IEC_UDINT = IECVar<UDINT_t>;
using IEC_ULINT = IECVar<ULINT_t>;

// Real numbers
using IEC_REAL = IECVar<REAL_t>;
using IEC_LREAL = IECVar<LREAL_t>;

// Time types
using IEC_TIME = IECVar<TIME_t>;
using IEC_DATE = IECVar<DATE_t>;
using IEC_TOD = IECVar<TOD_t>;
using IEC_DT = IECVar<DT_t>;

// IEC v3 Long time types
using IEC_LTIME = IECVar<LTIME_t>;
using IEC_LDATE = IECVar<LDATE_t>;
using IEC_LTOD = IECVar<LTOD_t>;
using IEC_LDT = IECVar<LDT_t>;

// Character types
using IEC_CHAR = IECVar<CHAR_t>;
using IEC_WCHAR = IECVar<WCHAR_t>;

// Aliases for compatibility
using IEC_TIME_OF_DAY = IEC_TOD;
using IEC_DATE_AND_TIME = IEC_DT;
using IEC_LONG_TIME_OF_DAY = IEC_LTOD;
using IEC_LONG_DATE_AND_TIME = IEC_LDT;

// =============================================================================
// Layout: every elementary wrapper is exactly its value
// =============================================================================

namespace detail {
/** True when wrapper W is laid out exactly as its value T. */
template<typename W, typename T>
struct is_packed_as
    : std::integral_constant<bool,
          sizeof(W) == sizeof(T) && alignof(W) == alignof(T) &&
          std::is_standard_layout<W>::value && std::is_trivially_copyable<W>::value> {};
}  // namespace detail

static_assert(detail::is_packed_as<IEC_BOOL, BOOL_t>::value, "IEC_BOOL must be its value");
static_assert(detail::is_packed_as<IEC_BYTE, BYTE_t>::value, "IEC_BYTE must be its value");
static_assert(detail::is_packed_as<IEC_WORD, WORD_t>::value, "IEC_WORD must be its value");
static_assert(detail::is_packed_as<IEC_DWORD, DWORD_t>::value, "IEC_DWORD must be its value");
static_assert(detail::is_packed_as<IEC_LWORD, LWORD_t>::value, "IEC_LWORD must be its value");
static_assert(detail::is_packed_as<IEC_SINT, SINT_t>::value, "IEC_SINT must be its value");
static_assert(detail::is_packed_as<IEC_INT, INT_t>::value, "IEC_INT must be its value");
static_assert(detail::is_packed_as<IEC_DINT, DINT_t>::value, "IEC_DINT must be its value");
static_assert(detail::is_packed_as<IEC_LINT, LINT_t>::value, "IEC_LINT must be its value");
static_assert(detail::is_packed_as<IEC_REAL, REAL_t>::value, "IEC_REAL must be its value");
static_assert(detail::is_packed_as<IEC_LREAL, LREAL_t>::value, "IEC_LREAL must be its value");
static_assert(detail::is_packed_as<IEC_TIME, TIME_t>::value, "IEC_TIME must be its value");
static_assert(detail::is_packed_as<IEC_CHAR, CHAR_t>::value, "IEC_CHAR must be its value");
static_assert(detail::is_packed_as<IEC_WCHAR, WCHAR_t>::value, "IEC_WCHAR must be its value");

} // namespace strucpp
