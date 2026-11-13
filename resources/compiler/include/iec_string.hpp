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
 * STruC++ Runtime - IEC String Types
 *
 * This header provides the IEC 61131-3 STRING type as a fixed-length string template.
 * STRING[n] represents a string with maximum length n (default 254 per IEC standard).
 * The implementation avoids dynamic memory allocation for real-time safety.
 */

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <algorithm>
#include <type_traits>
#include "iec_types.hpp"
#include "iec_var.hpp"
#include "iec_traits.hpp"

namespace strucpp {

// Forward declaration for cross-type assignment
template<size_t MaxLen> class IECStringVar;

/**
 * STRING(MaxLen) laid out as on a PLC: MaxLen + 1 characters, NUL-terminated.
 * The length is the position of the first NUL, at most MaxLen, so characters
 * and a 0 written through a POINTER TO ARRAY OF BYTE change what LEN reports.
 * Every operation that writes the string re-terminates it.
 */
template<size_t MaxLen = 254>
class STRUCPP_MAY_ALIAS IECString {
public:
    static constexpr size_t max_length = MaxLen;
    using value_type = CHAR_t;
    using size_type = size_t;

    constexpr IECString() noexcept : data_{} {}

    // A constructed string is zero past its terminator, as a PLC variable is,
    // so a pointer reading beyond the NUL sees zeros.
    IECString(const char* str) noexcept : data_{} {
        assign(str, str ? std::strlen(str) : 0);
    }

    IECString(const char* str, size_t len) noexcept : data_{} {
        assign(str, len);
    }

    template<size_t OtherLen>
    IECString(const IECString<OtherLen>& other) noexcept : data_{} {
        assign(other.c_str(), other.length());
    }

    IECString(const IECString&) = default;
    IECString(IECString&&) = default;
    IECString& operator=(const IECString&) = default;
    IECString& operator=(IECString&&) = default;

    IECString& operator=(const char* str) noexcept {
        assign(str, str ? std::strlen(str) : 0);
        return *this;
    }

    template<size_t OtherLen>
    IECString& operator=(const IECString<OtherLen>& other) noexcept {
        assign(other.c_str(), other.length());
        return *this;
    }

    // Cross-type assignment from IECStringVar (defined after IECStringVar class)
    template<size_t OtherLen>
    inline IECString& operator=(const IECStringVar<OtherLen>& other) noexcept;

    /** Characters before the first NUL, at most MaxLen. */
    size_t length() const noexcept {
        const void* nul = std::memchr(data_, 0, MaxLen);
        return nul ? static_cast<size_t>(static_cast<const char*>(nul) - data_) : MaxLen;
    }
    size_t size() const noexcept { return length(); }
    constexpr size_t capacity() const noexcept { return MaxLen; }
    bool empty() const noexcept { return data_[0] == '\0'; }

    /** NUL-terminated while only runtime operations wrote the string. */
    const char* c_str() const noexcept { return data_; }
    const char* data() const noexcept { return data_; }
    char* data() noexcept { return data_; }

    char operator[](size_t index) const noexcept {
        return index < length() ? data_[index] : '\0';
    }

    char& operator[](size_t index) noexcept {
        const size_t n = length();
        return data_[index < n ? index : n];
    }

    char at(size_t index) const noexcept {
        return index < length() ? data_[index] : '\0';
    }

    void clear() noexcept {
        data_[0] = '\0';
    }

    void resize(size_t new_len) noexcept {
        if (new_len > MaxLen) new_len = MaxLen;
        const size_t n = length();
        if (new_len > n) {
            std::memset(data_ + n, ' ', new_len - n);
        }
        data_[new_len] = '\0';
    }

    template<size_t OtherLen>
    IECString& append(const IECString<OtherLen>& other) noexcept {
        return append_chars(other.c_str(), other.length());
    }

    IECString& append(const char* str) noexcept {
        if (str) append_chars(str, std::strlen(str));
        return *this;
    }

    IECString& append(char c) noexcept {
        return append_chars(&c, 1);
    }

    template<size_t OtherLen>
    IECString operator+(const IECString<OtherLen>& other) const noexcept {
        IECString result(*this);
        result.append(other);
        return result;
    }

    IECString operator+(const char* str) const noexcept {
        IECString result(*this);
        result.append(str);
        return result;
    }

    template<size_t OtherLen>
    IECString& operator+=(const IECString<OtherLen>& other) noexcept {
        return append(other);
    }

    IECString& operator+=(const char* str) noexcept {
        return append(str);
    }

    IECString& operator+=(char c) noexcept {
        return append(c);
    }

    template<size_t OtherLen>
    bool operator==(const IECString<OtherLen>& other) const noexcept {
        const size_t n = length();
        if (n != other.length()) return false;
        return std::memcmp(data_, other.c_str(), n) == 0;
    }

    bool operator==(const char* str) const noexcept {
        if (!str) return empty();
        const size_t n = length();
        return std::strlen(str) == n && std::memcmp(data_, str, n) == 0;
    }

    template<size_t OtherLen>
    bool operator!=(const IECString<OtherLen>& other) const noexcept {
        return !(*this == other);
    }

    bool operator!=(const char* str) const noexcept {
        return !(*this == str);
    }

    template<size_t OtherLen>
    bool operator<(const IECString<OtherLen>& other) const noexcept {
        return compare(other) < 0;
    }

    template<size_t OtherLen>
    bool operator<=(const IECString<OtherLen>& other) const noexcept {
        return compare(other) <= 0;
    }

    template<size_t OtherLen>
    bool operator>(const IECString<OtherLen>& other) const noexcept {
        return compare(other) > 0;
    }

    template<size_t OtherLen>
    bool operator>=(const IECString<OtherLen>& other) const noexcept {
        return compare(other) >= 0;
    }

    /** strcmp order, bounded by both lengths. */
    template<size_t OtherLen>
    int compare(const IECString<OtherLen>& other) const noexcept {
        return compare_chars(other.c_str(), other.length());
    }

    int compare(const char* str) const noexcept {
        return compare_chars(str ? str : "", str ? std::strlen(str) : 0);
    }

    template<size_t OtherLen>
    size_t find(const IECString<OtherLen>& substr, size_t pos = 0) const noexcept {
        return find_chars(substr.c_str(), substr.length(), pos);
    }

    size_t find(const char* substr, size_t pos = 0) const noexcept {
        if (!substr) return npos;
        return find_chars(substr, std::strlen(substr), pos);
    }

    size_t find(char c, size_t pos = 0) const noexcept {
        const size_t n = length();
        for (size_t i = pos; i < n; ++i) {
            if (data_[i] == c) return i;
        }
        return npos;
    }

    IECString substr(size_t pos, size_t len = npos) const noexcept {
        const size_t n = length();
        if (pos >= n) return IECString();
        if (len == npos || pos + len > n) {
            len = n - pos;
        }
        return IECString(data_ + pos, len);
    }

    void replace(size_t pos, size_t len, const char* str) noexcept {
        const size_t n = length();
        if (pos >= n) return;
        if (pos + len > n) len = n - pos;

        size_t str_len = str ? std::strlen(str) : 0;
        size_t new_len = n - len + str_len;
        if (new_len > MaxLen) {
            str_len = MaxLen - (n - len);
            new_len = MaxLen;
        }

        if (str_len != len) {
            const size_t tail = n - pos - len;
            const size_t keep = pos + str_len + tail > MaxLen ? MaxLen - pos - str_len : tail;
            std::memmove(data_ + pos + str_len, data_ + pos + len, keep);
        }
        if (str_len > 0 && str) {
            std::memcpy(data_ + pos, str, str_len);
        }
        data_[new_len] = '\0';
    }

    void insert(size_t pos, const char* str) noexcept {
        const size_t n = length();
        if (pos > n) pos = n;
        if (!str) return;

        size_t str_len = std::strlen(str);
        if (n + str_len > MaxLen) {
            str_len = MaxLen - n;
        }

        std::memmove(data_ + pos + str_len, data_ + pos, n - pos);
        std::memcpy(data_ + pos, str, str_len);
        data_[n + str_len] = '\0';
    }

    void erase(size_t pos, size_t len = npos) noexcept {
        const size_t n = length();
        if (pos >= n) return;
        if (len == npos || pos + len > n) {
            len = n - pos;
        }
        std::memmove(data_ + pos, data_ + pos + len, n - pos - len);
        data_[n - len] = '\0';
    }

    static constexpr size_t npos = static_cast<size_t>(-1);

private:
    /** Store `len` characters of `str` (at most MaxLen, stopping at a NUL). */
    void assign(const char* str, size_t len) noexcept {
        if (len > MaxLen) len = MaxLen;
        if (len > 0) std::memmove(data_, str, len);
        data_[len] = '\0';
    }

    IECString& append_chars(const char* str, size_t count) noexcept {
        const size_t n = length();
        if (n + count > MaxLen) count = MaxLen - n;
        std::memcpy(data_ + n, str, count);
        data_[n + count] = '\0';
        return *this;
    }

    int compare_chars(const char* other, size_t other_len) const noexcept {
        const size_t n = length();
        const int c = std::memcmp(data_, other, n < other_len ? n : other_len);
        if (c != 0) return c;
        return n < other_len ? -1 : (n > other_len ? 1 : 0);
    }

    size_t find_chars(const char* sub, size_t sub_len, size_t pos) const noexcept {
        const size_t n = length();
        if (pos >= n || sub_len == 0 || sub_len > n) return npos;
        for (size_t i = pos; i + sub_len <= n; ++i) {
            if (std::memcmp(data_ + i, sub, sub_len) == 0) return i;
        }
        return npos;
    }

    char data_[MaxLen + 1];
};

using STRING = IECString<254>;

/**
 * A STRING(MaxLen) variable: exactly its IECString, so it is laid out as the
 * NUL-terminated characters. Forcing is held in the force table
 * (iec_force.hpp). Kept apart from IECString because REF(), the reference
 * traits and the comparison overloads tell a variable from a value.
 */
template<size_t MaxLen>
class STRUCPP_MAY_ALIAS IECStringVar {
public:
    using value_type = IECString<MaxLen>;

    IECStringVar() noexcept : value_{} {}
    IECStringVar(const value_type& v) noexcept : value_{v} {}
    IECStringVar(const char* str) noexcept : value_{str} {}

    IECStringVar(const IECStringVar&) = default;
    IECStringVar(IECStringVar&&) = default;
    IECStringVar& operator=(const IECStringVar&) = default;
    IECStringVar& operator=(IECStringVar&&) = default;

    // Cross-size converting constructor (IEC 61131-3: STRING types are interoperable)
    template<size_t OtherLen, std::enable_if_t<OtherLen != MaxLen, int> = 0>
    IECStringVar(const IECStringVar<OtherLen>& other) noexcept
        : value_(other.get()) {}

    // Converting constructor from IECString of any size
    template<size_t OtherLen, std::enable_if_t<OtherLen != MaxLen, int> = 0>
    IECStringVar(const IECString<OtherLen>& other) noexcept
        : value_(other) {}

    // Converting constructor from IECVar<IECString<N>> (struct field access returns this type)
    template<size_t OtherLen>
    IECStringVar(const IECVar<IECString<OtherLen>>& other) noexcept
        : value_(static_cast<IECString<OtherLen>>(other)) {}

    // Cross-size assignment (IEC 61131-3: STRING types are interoperable, truncation on overflow)
    template<size_t OtherLen>
    IECStringVar& operator=(const IECStringVar<OtherLen>& other) noexcept {
        value_ = other.get();
        return *this;
    }

    // Assignment from IECVar<IECString<N>> (struct field access)
    template<size_t OtherLen>
    IECStringVar& operator=(const IECVar<IECString<OtherLen>>& other) noexcept {
        value_ = static_cast<IECString<OtherLen>>(other);
        return *this;
    }

    // Assignment from IECString of different size
    template<size_t OtherLen, std::enable_if_t<OtherLen != MaxLen, int> = 0>
    IECStringVar& operator=(const IECString<OtherLen>& other) noexcept {
        value_ = other;
        return *this;
    }

    const value_type& get() const noexcept {
        return value_;
    }

    void set(const value_type& v) noexcept {
        value_ = v;
    }

    void set(const char* str) noexcept {
        value_ = str;
    }

    operator value_type() const noexcept {
        return value_;
    }

    IECStringVar& operator=(const value_type& v) noexcept {
        set(v);
        return *this;
    }

    IECStringVar& operator=(const char* str) noexcept {
        set(str);
        return *this;
    }

    // Read-through proxies into the inner IECString, so C/C++ POU bodies can
    // write `name.c_str()` / `name.length()`. Comparison is NOT proxied: the
    // free-function overloads at the bottom of this file handle every
    // cross-class compare, and member operators would make them ambiguous.
    size_t length() const noexcept {
        return value_.length();
    }
    const char* c_str() const noexcept {
        return value_.c_str();
    }
    char operator[](size_t index) const noexcept {
        return value_[index];
    }

private:
    value_type value_;
};

using STRING_VAR = IECStringVar<254>;

// Deferred definition: IECString::operator=(const IECStringVar<OtherLen>&)
// Template deduction doesn't consider user-defined conversions, so we need
// this explicit assignment to handle: rawStringField = stringVar
template<size_t MaxLen>
template<size_t OtherLen>
inline IECString<MaxLen>& IECString<MaxLen>::operator=(const IECStringVar<OtherLen>& other) noexcept {
    assign(other.c_str(), other.length());
    return *this;
}

// Comparison operators between IECString and IECStringVar
// (template deduction doesn't use implicit conversions)
template<size_t Len1, size_t Len2>
inline bool operator==(const IECString<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return a == b.get();
}

template<size_t Len1, size_t Len2>
inline bool operator==(const IECStringVar<Len1>& a, const IECString<Len2>& b) noexcept {
    return a.get() == b;
}

template<size_t Len1, size_t Len2>
inline bool operator==(const IECStringVar<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return a.get() == b.get();
}

template<size_t Len1, size_t Len2>
inline bool operator!=(const IECString<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return !(a == b);
}

template<size_t Len1, size_t Len2>
inline bool operator!=(const IECStringVar<Len1>& a, const IECString<Len2>& b) noexcept {
    return !(a == b);
}

template<size_t Len1, size_t Len2>
inline bool operator!=(const IECStringVar<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return !(a == b);
}

// Comparison operators for IECVar<IECString<N>> (struct field access returns this type)
// Template deduction won't chain through IECVar::operator T() + IECString comparison
template<size_t Len1, size_t Len2>
inline bool operator==(const IECVar<IECString<Len1>>& a, const IECStringVar<Len2>& b) noexcept {
    return static_cast<IECString<Len1>>(a) == b.get();
}
template<size_t Len1, size_t Len2>
inline bool operator==(const IECStringVar<Len1>& a, const IECVar<IECString<Len2>>& b) noexcept {
    return a.get() == static_cast<IECString<Len2>>(b);
}
template<size_t Len1, size_t Len2>
inline bool operator!=(const IECVar<IECString<Len1>>& a, const IECStringVar<Len2>& b) noexcept {
    return !(a == b);
}
template<size_t Len1, size_t Len2>
inline bool operator!=(const IECStringVar<Len1>& a, const IECVar<IECString<Len2>>& b) noexcept {
    return !(a == b);
}

// Comparison with const char*
template<size_t MaxLen>
inline bool operator==(const IECStringVar<MaxLen>& a, const char* b) noexcept {
    return a.get() == b;
}

template<size_t MaxLen>
inline bool operator==(const char* a, const IECStringVar<MaxLen>& b) noexcept {
    return b.get() == a;
}

template<size_t MaxLen>
inline bool operator!=(const IECStringVar<MaxLen>& a, const char* b) noexcept {
    return !(a == b);
}

template<size_t MaxLen>
inline bool operator!=(const char* a, const IECStringVar<MaxLen>& b) noexcept {
    return !(a == b);
}

// Ordering operators for IECStringVar
template<size_t Len1, size_t Len2>
inline bool operator<(const IECStringVar<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return a.get() < b.get();
}

template<size_t Len1, size_t Len2>
inline bool operator<(const IECString<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return a < b.get();
}

template<size_t Len1, size_t Len2>
inline bool operator<(const IECStringVar<Len1>& a, const IECString<Len2>& b) noexcept {
    return a.get() < b;
}

template<size_t Len1, size_t Len2>
inline bool operator>(const IECStringVar<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return b < a;
}

template<size_t Len1, size_t Len2>
inline bool operator>(const IECString<Len1>& a, const IECStringVar<Len2>& b) noexcept {
    return b < a;
}

template<size_t Len1, size_t Len2>
inline bool operator>(const IECStringVar<Len1>& a, const IECString<Len2>& b) noexcept {
    return b < a;
}

// Non-template alias for codegen: IEC_STRING = IECStringVar<254>
// For parameterized STRING(N), codegen emits IECStringVar<N> directly
using IEC_STRING = IECStringVar<254>;

template<size_t MaxLen>
inline size_t LEN(const IECString<MaxLen>& s) noexcept {
    return s.length();
}

// IECStringVar overload: template deduction doesn't go through implicit conversions
template<size_t MaxLen>
inline size_t LEN(const IECStringVar<MaxLen>& s) noexcept {
    return s.get().length();
}

template<size_t MaxLen>
inline IECString<MaxLen> LEFT(const IECString<MaxLen>& s, size_t len) noexcept {
    return s.substr(0, len);
}

template<size_t MaxLen>
inline IECString<MaxLen> RIGHT(const IECString<MaxLen>& s, size_t len) noexcept {
    if (len >= s.length()) return s;
    return s.substr(s.length() - len, len);
}

template<size_t MaxLen>
inline IECString<MaxLen> MID(const IECString<MaxLen>& s, size_t len, size_t pos) noexcept {
    if (pos == 0) return IECString<MaxLen>();
    return s.substr(pos - 1, len);
}

template<size_t MaxLen>
inline IECString<MaxLen> DELETE_STR(const IECString<MaxLen>& s, size_t len, size_t pos) noexcept {
    IECString<MaxLen> result(s);
    if (pos == 0) pos = 1;
    result.erase(pos - 1, len);
    return result;
}

// =============================================================================
// IECStringVar overloads — template deduction doesn't use implicit conversions,
// so we need explicit overloads that forward to the IECString versions via .get()
// =============================================================================

template<size_t MaxLen>
inline IECString<MaxLen> LEFT(const IECStringVar<MaxLen>& s, size_t len) noexcept {
    return LEFT(s.get(), len);
}

template<size_t MaxLen>
inline IECString<MaxLen> RIGHT(const IECStringVar<MaxLen>& s, size_t len) noexcept {
    return RIGHT(s.get(), len);
}

template<size_t MaxLen>
inline IECString<MaxLen> MID(const IECStringVar<MaxLen>& s, size_t len, size_t pos) noexcept {
    return MID(s.get(), len, pos);
}

template<size_t MaxLen>
inline IECString<MaxLen> DELETE_STR(const IECStringVar<MaxLen>& s, size_t len, size_t pos) noexcept {
    return DELETE_STR(s.get(), len, pos);
}

// =============================================================================
// IECVar<IECString<N>> overloads — struct field access returns this type.
// Template deduction won't chain through operator T().
// =============================================================================

template<size_t MaxLen>
inline size_t LEN(const IECVar<IECString<MaxLen>>& s) noexcept {
    return static_cast<IECString<MaxLen>>(s).length();
}

template<size_t MaxLen>
inline IECString<MaxLen> LEFT(const IECVar<IECString<MaxLen>>& s, size_t len) noexcept {
    return LEFT(static_cast<IECString<MaxLen>>(s), len);
}

template<size_t MaxLen>
inline IECString<MaxLen> RIGHT(const IECVar<IECString<MaxLen>>& s, size_t len) noexcept {
    return RIGHT(static_cast<IECString<MaxLen>>(s), len);
}

template<size_t MaxLen>
inline IECString<MaxLen> MID(const IECVar<IECString<MaxLen>>& s, size_t len, size_t pos) noexcept {
    return MID(static_cast<IECString<MaxLen>>(s), len, pos);
}

template<size_t MaxLen>
inline IECString<MaxLen> DELETE_STR(const IECVar<IECString<MaxLen>>& s, size_t len, size_t pos) noexcept {
    return DELETE_STR(static_cast<IECString<MaxLen>>(s), len, pos);
}

// =============================================================================
// STRING functions taking a string literal (codegen emits a bare literal as a
// C string), and the functions of two or more STRING arguments, each a value,
// a variable or a literal of any length.
// =============================================================================

namespace detail {
template<typename T> struct is_string_arg : std::false_type {};
template<size_t N> struct is_string_arg<IECString<N>> : std::true_type {};
template<size_t N> struct is_string_arg<IECStringVar<N>> : std::true_type {};
template<size_t N> struct is_string_arg<IECVar<IECString<N>>> : std::true_type {};
template<size_t N> struct is_string_arg<char[N]> : std::true_type {};


/** A STRING argument as a value; a literal is a STRING of the default length. */
template<size_t N> inline const IECString<N>& svalue(const IECString<N>& s) noexcept { return s; }
template<size_t N> inline IECString<N> svalue(const IECStringVar<N>& s) noexcept { return s.get(); }
template<size_t N> inline IECString<N> svalue(const IECVar<IECString<N>>& s) noexcept {
    return static_cast<IECString<N>>(s);
}
template<size_t N> inline STRING svalue(const char (&s)[N]) noexcept { return STRING(s); }
inline STRING svalue(const char* const& s) noexcept { return STRING(s); }

template<> struct is_string_arg<const char*> : std::true_type {};

/** Characters a STRING argument can hold; a literal is a default STRING. */
template<typename T> struct string_capacity;
template<size_t N> struct string_capacity<IECString<N>> : std::integral_constant<size_t, N> {};
template<size_t N> struct string_capacity<IECStringVar<N>> : std::integral_constant<size_t, N> {};
template<size_t N> struct string_capacity<IECVar<IECString<N>>> : std::integral_constant<size_t, N> {};
template<size_t N> struct string_capacity<char[N]> : std::integral_constant<size_t, STRING::max_length> {};
template<> struct string_capacity<const char*> : std::integral_constant<size_t, STRING::max_length> {};

/** The largest capacity among STRING arguments. */
template<typename A, typename... Rest> struct max_string_capacity
    : std::integral_constant<size_t,
          (string_capacity<A>::value > max_string_capacity<Rest...>::value
               ? string_capacity<A>::value : max_string_capacity<Rest...>::value)> {};
template<typename A> struct max_string_capacity<A> : string_capacity<A> {};

/**
 * The result of a function of several STRINGs: a full-length STRING, or the
 * longest argument type when that is longer. It is cut only when assigned.
 */
template<typename... Args>
using joined_string = IECString<
    (max_string_capacity<Args...>::value > STRING::max_length
         ? max_string_capacity<Args...>::value : STRING::max_length)>;

template<typename A>
using if_string_arg = typename std::enable_if<is_string_arg<A>::value, int>::type;
template<typename A, typename B>
using if_string_pair = typename std::enable_if<
    is_string_arg<A>::value && is_string_arg<B>::value, int>::type;
}  // namespace detail

/** CONCAT(IN1, IN2): IN1 followed by IN2. */
template<typename A, typename B, detail::if_string_pair<A, B> = 0>
inline detail::joined_string<A, B> CONCAT(const A& s1, const B& s2) noexcept {
    detail::joined_string<A, B> result(detail::svalue(s1));
    result.append(detail::svalue(s2));
    return result;
}

/** CONCAT of 3+ STRING arguments (IEC 61131-3 extensible function). */
template<typename A, typename B, typename C, typename... Rest,
         detail::if_string_pair<A, B> = 0, detail::if_string_arg<C> = 0>
inline detail::joined_string<A, B, C, Rest...>
CONCAT(const A& s1, const B& s2, const C& s3, const Rest&... rest) noexcept {
    // Widen first, so no partial result is cut to its own arguments' length.
    const detail::joined_string<A, B, C, Rest...> first(detail::svalue(s1));
    return CONCAT(CONCAT(first, s2), s3, rest...);
}

/** INSERT(IN1, IN2, P): IN2 after the first P characters of IN1. */
template<typename A, typename B, detail::if_string_pair<A, B> = 0>
inline detail::joined_string<A, B> INSERT(const A& s1, const B& s2, size_t pos) noexcept {
    detail::joined_string<A, B> result(detail::svalue(s1));
    if (pos > result.length()) pos = result.length();
    result.insert(pos, detail::svalue(s2).c_str());
    return result;
}

/** REPLACE(IN1, IN2, L, P): L characters of IN1 from position P replaced by IN2. */
template<typename A, typename B, detail::if_string_pair<A, B> = 0>
inline detail::joined_string<A, B> REPLACE(const A& s1, const B& s2, size_t len, size_t pos) noexcept {
    detail::joined_string<A, B> result(detail::svalue(s1));
    if (pos == 0) pos = 1;
    result.replace(pos - 1, len, detail::svalue(s2).c_str());
    return result;
}

/** FIND(IN1, IN2): the position of IN2 in IN1, from 1; 0 when absent. */
template<typename A, typename B, detail::if_string_pair<A, B> = 0>
inline size_t FIND(const A& s1, const B& s2) noexcept {
    const auto& haystack = detail::svalue(s1);
    const size_t pos = haystack.find(detail::svalue(s2));
    return pos == std::remove_reference<decltype(haystack)>::type::npos ? 0 : pos + 1;
}

template<size_t N>
inline size_t LEN(const char (&s)[N]) noexcept {
    return STRING(s).length();
}

template<size_t N>
inline STRING LEFT(const char (&s)[N], size_t len) noexcept {
    return LEFT(STRING(s), len);
}

template<size_t N>
inline STRING RIGHT(const char (&s)[N], size_t len) noexcept {
    return RIGHT(STRING(s), len);
}

template<size_t N>
inline STRING MID(const char (&s)[N], size_t len, size_t pos) noexcept {
    return MID(STRING(s), len, pos);
}

template<size_t N>
inline STRING DELETE_STR(const char (&s)[N], size_t len, size_t pos) noexcept {
    return DELETE_STR(STRING(s), len, pos);
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool GT_STRING(const IECString<MaxLen1>& s1, const IECString<MaxLen2>& s2) noexcept {
    return s1 > s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool GE_STRING(const IECString<MaxLen1>& s1, const IECString<MaxLen2>& s2) noexcept {
    return s1 >= s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool EQ_STRING(const IECString<MaxLen1>& s1, const IECString<MaxLen2>& s2) noexcept {
    return s1 == s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool LE_STRING(const IECString<MaxLen1>& s1, const IECString<MaxLen2>& s2) noexcept {
    return s1 <= s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool LT_STRING(const IECString<MaxLen1>& s1, const IECString<MaxLen2>& s2) noexcept {
    return s1 < s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool NE_STRING(const IECString<MaxLen1>& s1, const IECString<MaxLen2>& s2) noexcept {
    return s1 != s2;
}

// =============================================================================
// TO_STRING Conversions
// =============================================================================

// Numeric → STRING (uses snprintf for real-time safety, no std::to_string)
//
// Split into two SFINAE'd overloads (signed vs unsigned) rather than a single
// function with `if constexpr`, because user C/C++ POU code in
// `c_blocks_code.cpp` compiles under whatever -std= the platform's Arduino
// core picked (gnu++14 on mbed cores).  `if constexpr` is C++17-only and
// would make this header unusable from those compilation units.  Tag
// dispatch via `enable_if_t` works back to C++11.
template<typename T,
    std::enable_if_t<std::is_integral<decltype(iec_unwrap(std::declval<T>()))>::value
                  && std::is_unsigned<decltype(iec_unwrap(std::declval<T>()))>::value, int> = 0>
inline IECString<254> TO_STRING(T v) noexcept {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(iec_unwrap(v)));
    return IECString<254>(buf);
}

template<typename T,
    std::enable_if_t<std::is_integral<decltype(iec_unwrap(std::declval<T>()))>::value
                  && !std::is_unsigned<decltype(iec_unwrap(std::declval<T>()))>::value, int> = 0>
inline IECString<254> TO_STRING(T v) noexcept {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(iec_unwrap(v)));
    return IECString<254>(buf);
}

template<typename T,
    std::enable_if_t<std::is_floating_point<decltype(iec_unwrap(std::declval<T>()))>::value, int> = 0>
inline IECString<254> TO_STRING(T v) noexcept {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%g", static_cast<double>(iec_unwrap(v)));
    return IECString<254>(buf);
}

// BOOL → STRING
inline IECString<254> TO_STRING(IECVar<bool> v) noexcept {
    return IECString<254>(iec_unwrap(v) ? "TRUE" : "FALSE");
}

// IECString → STRING (identity / cross-size copy)
template<size_t N>
inline IECString<254> TO_STRING(const IECString<N>& v) noexcept {
    return IECString<254>(v.c_str());
}

template<size_t N>
inline IECString<254> TO_STRING(const IECStringVar<N>& v) noexcept {
    return IECString<254>(v.get().c_str());
}

// =============================================================================
// OSCAT-Compatible String Functions
// =============================================================================

// CODE - Return ASCII code of first character
template<size_t N>
inline int32_t CODE(const IECString<N>& s) noexcept {
    return s.length() > 0 ? static_cast<int32_t>(static_cast<unsigned char>(s[0])) : 0;
}

template<size_t N>
inline int32_t CODE(const IECStringVar<N>& s) noexcept {
    return CODE(s.get());
}

// CHR - Return string from ASCII code
inline IECString<254> CHR(int32_t code) noexcept {
    char buf[2] = { static_cast<char>(code), '\0' };
    return IECString<254>(buf);
}

// TRIM - Remove leading and trailing whitespace
template<size_t N>
inline IECString<N> TRIM(const IECString<N>& s) noexcept {
    const char* start = s.c_str();
    const char* end = start + s.length();
    while (start < end && (*start == ' ' || *start == '\t' || *start == '\r' || *start == '\n')) ++start;
    while (end > start && (*(end-1) == ' ' || *(end-1) == '\t' || *(end-1) == '\r' || *(end-1) == '\n')) --end;
    return IECString<N>(start, static_cast<size_t>(end - start));
}

template<size_t N>
inline IECString<N> TRIM(const IECStringVar<N>& s) noexcept {
    return TRIM(s.get());
}

// LOWERCASE / TOUPPER - Case conversion (OSCAT uses these names)
template<size_t N>
inline IECString<N> LOWERCASE(const IECString<N>& s) noexcept {
    IECString<N> result(s);
    for (size_t i = 0; i < result.length(); ++i) {
        char c = result[i];
        if (c >= 'A' && c <= 'Z') result[i] = c + ('a' - 'A');
    }
    return result;
}

template<size_t N>
inline IECString<N> LOWERCASE(const IECStringVar<N>& s) noexcept {
    return LOWERCASE(s.get());
}

template<size_t N>
inline IECString<N> UPPERCASE(const IECString<N>& s) noexcept {
    IECString<N> result(s);
    for (size_t i = 0; i < result.length(); ++i) {
        char c = result[i];
        if (c >= 'a' && c <= 'z') result[i] = c - ('a' - 'A');
    }
    return result;
}

template<size_t N>
inline IECString<N> UPPERCASE(const IECStringVar<N>& s) noexcept {
    return UPPERCASE(s.get());
}

// =============================================================================
// String-to-Numeric Conversions
// IEC 61131-3: STRING_TO_INT, STRING_TO_REAL, etc.
// Placed here because they need both IECString and IEC_INT/IEC_REAL types.
// =============================================================================

template<size_t N>
inline IEC_INT TO_INT(const IECString<N>& s) noexcept {
    return IEC_INT(static_cast<INT_t>(std::strtol(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_INT TO_INT(const IECStringVar<N>& s) noexcept {
    return TO_INT(s.get());
}
template<size_t N>
inline IEC_REAL TO_REAL(const IECString<N>& s) noexcept {
    return IEC_REAL(static_cast<REAL_t>(std::strtod(s.c_str(), nullptr)));
}
template<size_t N>
inline IEC_REAL TO_REAL(const IECStringVar<N>& s) noexcept {
    return TO_REAL(s.get());
}
template<size_t N>
inline IEC_LREAL TO_LREAL(const IECString<N>& s) noexcept {
    return IEC_LREAL(static_cast<LREAL_t>(std::strtod(s.c_str(), nullptr)));
}
template<size_t N>
inline IEC_LREAL TO_LREAL(const IECStringVar<N>& s) noexcept {
    return TO_LREAL(s.get());
}
template<size_t N>
inline IEC_DINT TO_DINT(const IECString<N>& s) noexcept {
    return IEC_DINT(static_cast<DINT_t>(std::strtol(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_DINT TO_DINT(const IECStringVar<N>& s) noexcept {
    return TO_DINT(s.get());
}

template<size_t N>
inline IEC_SINT TO_SINT(const IECString<N>& s) noexcept {
    return IEC_SINT(static_cast<SINT_t>(std::strtol(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_SINT TO_SINT(const IECStringVar<N>& s) noexcept {
    return TO_SINT(s.get());
}

template<size_t N>
inline IEC_LINT TO_LINT(const IECString<N>& s) noexcept {
    return IEC_LINT(static_cast<LINT_t>(std::strtoll(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_LINT TO_LINT(const IECStringVar<N>& s) noexcept {
    return TO_LINT(s.get());
}

template<size_t N>
inline IEC_USINT TO_USINT(const IECString<N>& s) noexcept {
    return IEC_USINT(static_cast<USINT_t>(std::strtoul(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_USINT TO_USINT(const IECStringVar<N>& s) noexcept {
    return TO_USINT(s.get());
}

template<size_t N>
inline IEC_UINT TO_UINT(const IECString<N>& s) noexcept {
    return IEC_UINT(static_cast<UINT_t>(std::strtoul(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_UINT TO_UINT(const IECStringVar<N>& s) noexcept {
    return TO_UINT(s.get());
}

template<size_t N>
inline IEC_UDINT TO_UDINT(const IECString<N>& s) noexcept {
    return IEC_UDINT(static_cast<UDINT_t>(std::strtoul(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_UDINT TO_UDINT(const IECStringVar<N>& s) noexcept {
    return TO_UDINT(s.get());
}

template<size_t N>
inline IEC_ULINT TO_ULINT(const IECString<N>& s) noexcept {
    return IEC_ULINT(static_cast<ULINT_t>(std::strtoull(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_ULINT TO_ULINT(const IECStringVar<N>& s) noexcept {
    return TO_ULINT(s.get());
}

template<size_t N>
inline IEC_BYTE TO_BYTE(const IECString<N>& s) noexcept {
    return IEC_BYTE(static_cast<BYTE_t>(std::strtoul(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_BYTE TO_BYTE(const IECStringVar<N>& s) noexcept {
    return TO_BYTE(s.get());
}

template<size_t N>
inline IEC_WORD TO_WORD(const IECString<N>& s) noexcept {
    return IEC_WORD(static_cast<WORD_t>(std::strtoul(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_WORD TO_WORD(const IECStringVar<N>& s) noexcept {
    return TO_WORD(s.get());
}

template<size_t N>
inline IEC_DWORD TO_DWORD(const IECString<N>& s) noexcept {
    return IEC_DWORD(static_cast<DWORD_t>(std::strtoul(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_DWORD TO_DWORD(const IECStringVar<N>& s) noexcept {
    return TO_DWORD(s.get());
}

template<size_t N>
inline IEC_LWORD TO_LWORD(const IECString<N>& s) noexcept {
    return IEC_LWORD(static_cast<LWORD_t>(std::strtoull(s.c_str(), nullptr, 10)));
}
template<size_t N>
inline IEC_LWORD TO_LWORD(const IECStringVar<N>& s) noexcept {
    return TO_LWORD(s.get());
}

template<size_t N>
inline IEC_BOOL TO_BOOL(const IECString<N>& s) noexcept {
    // "TRUE" or "1" → true, everything else → false
    return IEC_BOOL(s.length() > 0 && (s[0] == 'T' || s[0] == 't' || s[0] == '1'));
}
template<size_t N>
inline IEC_BOOL TO_BOOL(const IECStringVar<N>& s) noexcept {
    return TO_BOOL(s.get());
}

} // namespace strucpp
