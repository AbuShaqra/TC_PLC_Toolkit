// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Wide String Types
 *
 * This header provides the IEC 61131-3 WSTRING type as a fixed-length wide string template.
 * WSTRING[n] represents a wide string with maximum length n (default 254 per IEC standard).
 * Uses char16_t (UTF-16) for wide character storage.
 * The implementation avoids dynamic memory allocation for real-time safety.
 */

#pragma once

#include <cstdint>
#include <cstring>
#include <algorithm>
#include <type_traits>
#include "iec_types.hpp"
#include "iec_fault.hpp"

namespace strucpp {

template<size_t MaxLen = 254>
class STRUCPP_MAY_ALIAS IECWString {
public:
    static constexpr size_t max_length = MaxLen;
    using value_type = WCHAR_t;
    using size_type = size_t;

    constexpr IECWString() noexcept : data_{} {}

    IECWString(const char16_t* str) noexcept : data_{} {
        size_t cur = 0;
        if (str) {
            size_t len = 0;
            while (str[len] != u'\0' && len < MaxLen) ++len;
            cur = len;
            for (size_t i = 0; i < cur; ++i) {
                data_[i] = str[i];
            }
        }
        data_[cur] = u'\0';
    }

    IECWString(const char16_t* str, size_t len) noexcept : data_{} {
        size_t cur = len < MaxLen ? len : MaxLen;
        for (size_t i = 0; i < cur; ++i) {
            data_[i] = str[i];
        }
        data_[cur] = u'\0';
    }

    template<size_t OtherLen>
    IECWString(const IECWString<OtherLen>& other) noexcept : data_{} {
        size_t cur = other.length() < MaxLen ? other.length() : MaxLen;
        for (size_t i = 0; i < cur; ++i) {
            data_[i] = other.c_str()[i];
        }
        data_[cur] = u'\0';
    }

    IECWString(const IECWString&) = default;
    IECWString(IECWString&&) = default;
    IECWString& operator=(const IECWString&) = default;
    IECWString& operator=(IECWString&&) = default;

    IECWString& operator=(const char16_t* str) noexcept {
        size_t cur = len_();
        if (str) {
            size_t len = 0;
            while (str[len] != u'\0' && len < MaxLen) ++len;
            cur = len;
            for (size_t i = 0; i < cur; ++i) {
                data_[i] = str[i];
            }
        } else {
            cur = 0;
        }
        data_[cur] = u'\0';
        return *this;
    }

    template<size_t OtherLen>
    IECWString& operator=(const IECWString<OtherLen>& other) noexcept {
        size_t cur = len_();
        cur = other.length() < MaxLen ? other.length() : MaxLen;
        for (size_t i = 0; i < cur; ++i) {
            data_[i] = other.c_str()[i];
        }
        data_[cur] = u'\0';
        return *this;
    }

    size_t length() const noexcept { return len_(); }
    size_t size() const noexcept { return len_(); }
    constexpr size_t capacity() const noexcept { return MaxLen; }
    bool empty() const noexcept { return data_[0] == u'\0'; }

    const char16_t* c_str() const noexcept { return data_; }
    const char16_t* data() const noexcept { return data_; }
    char16_t* data() noexcept { return data_; }

    char16_t operator[](size_t index) const noexcept {
        size_t cur = len_();
        return index < cur ? data_[index] : u'\0';
    }

    char16_t& operator[](size_t index) noexcept {
        size_t cur = len_();
        return data_[index < cur ? index : cur];
    }

    char16_t at(size_t index) const noexcept {
        size_t cur = len_();
        return index < cur ? data_[index] : u'\0';
    }

    void clear() noexcept {
        data_[0] = u'\0';
    }

    void resize(size_t new_len) noexcept {
        size_t cur = len_();
        if (new_len > MaxLen) new_len = MaxLen;
        if (new_len > cur) {
            for (size_t i = cur; i < new_len; ++i) {
                data_[i] = u' ';
            }
        }
        cur = new_len;
        data_[cur] = u'\0';
    }

    template<size_t OtherLen>
    IECWString& append(const IECWString<OtherLen>& other) noexcept {
        size_t cur = len_();
        size_t copy_len = other.length();
        if (cur + copy_len > MaxLen) {
            copy_len = MaxLen - cur;
        }
        for (size_t i = 0; i < copy_len; ++i) {
            data_[cur + i] = other.c_str()[i];
        }
        cur += copy_len;
        data_[cur] = u'\0';
        return *this;
    }

    IECWString& append(const char16_t* str) noexcept {
        size_t cur = len_();
        if (str) {
            size_t str_len = 0;
            while (str[str_len] != u'\0') ++str_len;
            size_t copy_len = str_len;
            if (cur + copy_len > MaxLen) {
                copy_len = MaxLen - cur;
            }
            for (size_t i = 0; i < copy_len; ++i) {
                data_[cur + i] = str[i];
            }
            cur += copy_len;
            data_[cur] = u'\0';
        }
        return *this;
    }

    IECWString& append(char16_t c) noexcept {
        size_t cur = len_();
        if (cur < MaxLen) {
            data_[cur++] = c;
            data_[cur] = u'\0';
        }
        return *this;
    }

    template<size_t OtherLen>
    IECWString operator+(const IECWString<OtherLen>& other) const noexcept {
        IECWString result(*this);
        result.append(other);
        return result;
    }

    IECWString operator+(const char16_t* str) const noexcept {
        IECWString result(*this);
        result.append(str);
        return result;
    }

    template<size_t OtherLen>
    IECWString& operator+=(const IECWString<OtherLen>& other) noexcept {
        return append(other);
    }

    IECWString& operator+=(const char16_t* str) noexcept {
        return append(str);
    }

    IECWString& operator+=(char16_t c) noexcept {
        return append(c);
    }

    template<size_t OtherLen>
    bool operator==(const IECWString<OtherLen>& other) const noexcept {
        size_t cur = len_();
        if (cur != other.length()) return false;
        for (size_t i = 0; i < cur; ++i) {
            if (data_[i] != other.c_str()[i]) return false;
        }
        return true;
    }

    bool operator==(const char16_t* str) const noexcept {
        size_t cur = len_();
        if (!str) return cur == 0;
        size_t i = 0;
        while (i < cur && str[i] != u'\0') {
            if (data_[i] != str[i]) return false;
            ++i;
        }
        return i == cur && str[i] == u'\0';
    }

    template<size_t OtherLen>
    bool operator!=(const IECWString<OtherLen>& other) const noexcept {
        return !(*this == other);
    }

    bool operator!=(const char16_t* str) const noexcept {
        return !(*this == str);
    }

    template<size_t OtherLen>
    bool operator<(const IECWString<OtherLen>& other) const noexcept {
        size_t cur = len_();
        size_t min_len = cur < other.length() ? cur : other.length();
        for (size_t i = 0; i < min_len; ++i) {
            if (data_[i] < other.c_str()[i]) return true;
            if (data_[i] > other.c_str()[i]) return false;
        }
        return cur < other.length();
    }

    template<size_t OtherLen>
    bool operator<=(const IECWString<OtherLen>& other) const noexcept {
        return !(other < *this);
    }

    template<size_t OtherLen>
    bool operator>(const IECWString<OtherLen>& other) const noexcept {
        return other < *this;
    }

    template<size_t OtherLen>
    bool operator>=(const IECWString<OtherLen>& other) const noexcept {
        return !(*this < other);
    }

    template<size_t OtherLen>
    int compare(const IECWString<OtherLen>& other) const noexcept {
        size_t cur = len_();
        size_t min_len = cur < other.length() ? cur : other.length();
        for (size_t i = 0; i < min_len; ++i) {
            if (data_[i] < other.c_str()[i]) return -1;
            if (data_[i] > other.c_str()[i]) return 1;
        }
        if (cur < other.length()) return -1;
        if (cur > other.length()) return 1;
        return 0;
    }

    template<size_t OtherLen>
    size_t find(const IECWString<OtherLen>& substr, size_t pos = 0) const noexcept {
        size_t cur = len_();
        if (pos >= cur || substr.length() == 0) return npos;
        if (substr.length() > cur - pos) return npos;
        
        for (size_t i = pos; i <= cur - substr.length(); ++i) {
            bool found = true;
            for (size_t j = 0; j < substr.length(); ++j) {
                if (data_[i + j] != substr.c_str()[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return i;
        }
        return npos;
    }

    size_t find(char16_t c, size_t pos = 0) const noexcept {
        size_t cur = len_();
        for (size_t i = pos; i < cur; ++i) {
            if (data_[i] == c) return i;
        }
        return npos;
    }

    IECWString substr(size_t pos, size_t len = npos) const noexcept {
        size_t cur = len_();
        if (pos >= cur) return IECWString();
        if (len == npos || pos + len > cur) {
            len = cur - pos;
        }
        return IECWString(data_ + pos, len);
    }

    void replace(size_t pos, size_t len, const char16_t* str) noexcept {
        size_t cur = len_();
        if (pos >= cur) return;
        if (pos + len > cur) len = cur - pos;
        
        size_t str_len = 0;
        if (str) {
            while (str[str_len] != u'\0') ++str_len;
        }
        
        size_t new_len = cur - len + str_len;
        if (new_len > MaxLen) {
            str_len = MaxLen - (cur - len);
            new_len = MaxLen;
        }
        
        if (str_len != len) {
            for (size_t i = 0; i < cur - pos - len; ++i) {
                data_[pos + str_len + i] = data_[pos + len + i];
            }
        }
        if (str_len > 0 && str) {
            for (size_t i = 0; i < str_len; ++i) {
                data_[pos + i] = str[i];
            }
        }
        cur = new_len;
        data_[cur] = u'\0';
    }

    void insert(size_t pos, const char16_t* str) noexcept {
        size_t cur = len_();
        if (pos > cur) pos = cur;
        if (!str) return;
        
        size_t str_len = 0;
        while (str[str_len] != u'\0') ++str_len;
        
        if (cur + str_len > MaxLen) {
            str_len = MaxLen - cur;
        }
        
        for (size_t i = cur - pos; i > 0; --i) {
            data_[pos + str_len + i - 1] = data_[pos + i - 1];
        }
        for (size_t i = 0; i < str_len; ++i) {
            data_[pos + i] = str[i];
        }
        cur += str_len;
        data_[cur] = u'\0';
    }

    void erase(size_t pos, size_t len = npos) noexcept {
        size_t cur = len_();
        if (pos >= cur) return;
        if (len == npos || pos + len > cur) {
            len = cur - pos;
        }
        for (size_t i = 0; i < cur - pos - len; ++i) {
            data_[pos + i] = data_[pos + len + i];
        }
        cur -= len;
        data_[cur] = u'\0';
    }

    static constexpr size_t npos = static_cast<size_t>(-1);

private:
    /** Code units before the first NUL, at most MaxLen. */
    size_t len_() const noexcept {
        size_t n = 0;
        while (n < MaxLen && data_[n] != u'\0') ++n;
        return n;
    }

    char16_t data_[MaxLen + 1];
};

using WSTRING = IECWString<254>;

/**
 * A WSTRING(MaxLen) variable: exactly its IECWString, so it is laid out as the
 * NUL-terminated code units. Forcing is held in the force table
 * (iec_force.hpp).
 */
template<size_t MaxLen>
class STRUCPP_MAY_ALIAS IECWStringVar {
public:
    using value_type = IECWString<MaxLen>;

    IECWStringVar() noexcept : value_{} {}
    IECWStringVar(const value_type& v) noexcept : value_{v} {}
    IECWStringVar(const char16_t* str) noexcept : value_{str} {}

    IECWStringVar(const IECWStringVar&) = default;
    IECWStringVar(IECWStringVar&&) = default;
    IECWStringVar& operator=(const IECWStringVar&) = default;
    IECWStringVar& operator=(IECWStringVar&&) = default;

    // Cross-size assignment (IEC 61131-3: WSTRING types are interoperable, truncation on overflow)
    template<size_t OtherLen>
    IECWStringVar& operator=(const IECWStringVar<OtherLen>& other) noexcept {
        value_ = IECWString<MaxLen>(other.c_str(), other.length());
        return *this;
    }

    const value_type& get() const noexcept {
        return value_;
    }

    void set(const value_type& v) noexcept {
        value_ = v;
    }

    void set(const char16_t* str) noexcept {
        value_ = str;
    }

    operator value_type() const noexcept {
        return value_;
    }

    IECWStringVar& operator=(const value_type& v) noexcept {
        set(v);
        return *this;
    }

    IECWStringVar& operator=(const char16_t* str) noexcept {
        set(str);
        return *this;
    }

    // Read-through proxies into the inner IECWString; mirror of IECStringVar's.
    size_t length() const noexcept {
        return value_.length();
    }
    const char16_t* c_str() const noexcept {
        return value_.c_str();
    }
    char16_t operator[](size_t index) const noexcept {
        return value_[index];
    }

    /** Ed. 3 `w[i]`: the i-th code unit, from 1 to the current length. */
    char16_t& at(int64_t index) {
        if (index < 1 || static_cast<size_t>(index) > value_.length()) {
            iec_string_index_fault();
        }
        return value_.data()[index - 1];
    }
    char16_t at(int64_t index) const {
        if (index < 1 || static_cast<size_t>(index) > value_.length()) {
            iec_string_index_fault();
        }
        return value_.data()[index - 1];
    }

private:
    value_type value_;
};

using WSTRING_VAR = IECWStringVar<254>;

// Non-template alias for codegen: IEC_WSTRING = IECWStringVar<254>
// For parameterized WSTRING(N), codegen emits IECWStringVar<N> directly
using IEC_WSTRING = IECWStringVar<254>;

template<size_t MaxLen>
inline size_t WLEN(const IECWString<MaxLen>& s) noexcept {
    return s.length();
}

template<size_t MaxLen>
inline IECWString<MaxLen> WLEFT(const IECWString<MaxLen>& s, size_t len) noexcept {
    return s.substr(0, len);
}

template<size_t MaxLen>
inline IECWString<MaxLen> WRIGHT(const IECWString<MaxLen>& s, size_t len) noexcept {
    if (len >= s.length()) return s;
    return s.substr(s.length() - len, len);
}

template<size_t MaxLen>
inline IECWString<MaxLen> WMID(const IECWString<MaxLen>& s, size_t pos, size_t len) noexcept {
    if (pos == 0) return IECWString<MaxLen>();
    return s.substr(pos - 1, len);
}

template<size_t MaxLen1, size_t MaxLen2>
inline IECWString<(MaxLen1 > MaxLen2 ? MaxLen1 : MaxLen2)> 
WCONCAT(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    constexpr size_t ResultLen = MaxLen1 > MaxLen2 ? MaxLen1 : MaxLen2;
    IECWString<ResultLen> result(s1);
    result.append(s2);
    return result;
}

/** WINSERT(IN1, IN2, P): IN2 after the first P characters of IN1. */
template<size_t MaxLen>
inline IECWString<MaxLen> WINSERT(const IECWString<MaxLen>& s1, const IECWString<MaxLen>& s2, size_t pos) noexcept {
    IECWString<MaxLen> result(s1);
    if (pos > result.length()) pos = result.length();
    result.insert(pos, s2.c_str());
    return result;
}

template<size_t MaxLen>
inline IECWString<MaxLen> WDELETE(const IECWString<MaxLen>& s, size_t len, size_t pos) noexcept {
    IECWString<MaxLen> result(s);
    if (pos == 0) pos = 1;
    result.erase(pos - 1, len);
    return result;
}

template<size_t MaxLen>
inline IECWString<MaxLen> WREPLACE(const IECWString<MaxLen>& s1, const IECWString<MaxLen>& s2, size_t len, size_t pos) noexcept {
    IECWString<MaxLen> result(s1);
    if (pos == 0) pos = 1;
    result.replace(pos - 1, len, s2.c_str());
    return result;
}

template<size_t MaxLen1, size_t MaxLen2>
inline size_t WFIND(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    size_t pos = s1.find(s2);
    return pos == IECWString<MaxLen1>::npos ? 0 : pos + 1;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool GT_WSTRING(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    return s1 > s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool GE_WSTRING(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    return s1 >= s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool EQ_WSTRING(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    return s1 == s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool LE_WSTRING(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    return s1 <= s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool LT_WSTRING(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    return s1 < s2;
}

template<size_t MaxLen1, size_t MaxLen2>
inline bool NE_WSTRING(const IECWString<MaxLen1>& s1, const IECWString<MaxLen2>& s2) noexcept {
    return s1 != s2;
}

// =============================================================================
// Standard string functions on WSTRING (IEC 61131-3 ANY_STRING): LEN, LEFT,
// RIGHT, MID, CONCAT, INSERT, DELETE, REPLACE, FIND on a WSTRING value or
// variable, any length, with the STRING versions' argument order.
// =============================================================================

namespace detail {
template<typename T> struct is_wstring : std::false_type {};
template<size_t N> struct is_wstring<IECWString<N>> : std::true_type { static constexpr size_t len = N; };
template<size_t N> struct is_wstring<IECWStringVar<N>> : std::true_type { static constexpr size_t len = N; };

template<size_t N> inline IECWString<N> wvalue(const IECWString<N>& s) noexcept { return s; }
template<size_t N> inline IECWString<N> wvalue(const IECWStringVar<N>& s) noexcept { return s.get(); }
template<size_t N> inline WSTRING wvalue(const char16_t (&s)[N]) noexcept { return WSTRING(s); }

/** A WSTRING function argument: a string, a variable or a literal (default length). */
template<typename T> struct is_wstring_arg : is_wstring<T> {};
template<size_t N> struct is_wstring_arg<char16_t[N]> : std::true_type {
    static constexpr size_t len = 254;
};

template<typename S> using wstring_value_t = IECWString<is_wstring_arg<S>::len>;

/** The largest capacity among WSTRING arguments. */
template<typename A, typename... Rest> struct max_wstring_capacity
    : std::integral_constant<size_t,
          (is_wstring_arg<A>::len > max_wstring_capacity<Rest...>::value
               ? is_wstring_arg<A>::len : max_wstring_capacity<Rest...>::value)> {};
template<typename A> struct max_wstring_capacity<A>
    : std::integral_constant<size_t, is_wstring_arg<A>::len> {};

/**
 * The result of a function of several WSTRINGs: a full-length WSTRING, or the
 * longest argument type when that is longer. It is cut only when assigned.
 */
template<typename... Args>
using joined_wstring = IECWString<
    (max_wstring_capacity<Args...>::value > 254 ? max_wstring_capacity<Args...>::value : 254)>;
template<typename S, typename R = void>
using if_wstring = typename std::enable_if<is_wstring_arg<S>::value, R>::type;
}  // namespace detail

namespace detail {
template<typename T> struct is_wstring_var : std::false_type {};
template<size_t N> struct is_wstring_var<IECWStringVar<N>> : std::true_type {};
/** Two WSTRING operands, at least one a variable (an IECWString pair uses its members). */
template<typename A, typename B>
using if_wstring_var_pair = typename std::enable_if<
    is_wstring<A>::value && is_wstring<B>::value &&
    (is_wstring_var<A>::value || is_wstring_var<B>::value), bool>::type;
template<typename A>
using if_wstring_var = typename std::enable_if<is_wstring_var<A>::value, bool>::type;
}  // namespace detail

// Comparison of a WSTRING variable with a WSTRING value, variable or literal
template<typename A, typename B> inline detail::if_wstring_var_pair<A, B> operator==(const A& a, const B& b) noexcept { return detail::wvalue(a) == detail::wvalue(b); }
template<typename A, typename B> inline detail::if_wstring_var_pair<A, B> operator!=(const A& a, const B& b) noexcept { return detail::wvalue(a) != detail::wvalue(b); }
template<typename A, typename B> inline detail::if_wstring_var_pair<A, B> operator<(const A& a, const B& b) noexcept { return detail::wvalue(a) < detail::wvalue(b); }
template<typename A, typename B> inline detail::if_wstring_var_pair<A, B> operator<=(const A& a, const B& b) noexcept { return detail::wvalue(a) <= detail::wvalue(b); }
template<typename A, typename B> inline detail::if_wstring_var_pair<A, B> operator>(const A& a, const B& b) noexcept { return detail::wvalue(a) > detail::wvalue(b); }
template<typename A, typename B> inline detail::if_wstring_var_pair<A, B> operator>=(const A& a, const B& b) noexcept { return detail::wvalue(a) >= detail::wvalue(b); }
template<typename A> inline detail::if_wstring_var<A> operator==(const A& a, const char16_t* b) noexcept { return detail::wvalue(a) == b; }
template<typename A> inline detail::if_wstring_var<A> operator!=(const A& a, const char16_t* b) noexcept { return detail::wvalue(a) != b; }
template<typename A> inline detail::if_wstring_var<A> operator==(const char16_t* a, const A& b) noexcept { return detail::wvalue(b) == a; }
template<typename A> inline detail::if_wstring_var<A> operator!=(const char16_t* a, const A& b) noexcept { return detail::wvalue(b) != a; }

template<typename S, typename = detail::if_wstring<S>>
inline size_t LEN(const S& s) noexcept {
    return detail::wvalue(s).length();
}

template<typename S, typename = detail::if_wstring<S>>
inline detail::wstring_value_t<S> LEFT(const S& s, size_t len) noexcept {
    return WLEFT(detail::wvalue(s), len);
}

template<typename S, typename = detail::if_wstring<S>>
inline detail::wstring_value_t<S> RIGHT(const S& s, size_t len) noexcept {
    return WRIGHT(detail::wvalue(s), len);
}

/** MID(IN, L, P): L characters starting at position P, counted from 1. */
template<typename S, typename = detail::if_wstring<S>>
inline detail::wstring_value_t<S> MID(const S& s, size_t len, size_t pos) noexcept {
    return WMID(detail::wvalue(s), pos, len);
}

template<typename A, typename B, typename = detail::if_wstring<A>, typename = detail::if_wstring<B>>
inline detail::joined_wstring<A, B> CONCAT(const A& s1, const B& s2) noexcept {
    detail::joined_wstring<A, B> result(detail::wvalue(s1));
    result.append(detail::wvalue(s2));
    return result;
}

template<typename A, typename B, typename C, typename... Rest,
         typename = detail::if_wstring<A>, typename = detail::if_wstring<B>>
inline detail::joined_wstring<A, B, C, Rest...>
CONCAT(const A& s1, const B& s2, const C& s3, const Rest&... rest) noexcept {
    // Widen first, so no partial result is cut to its own arguments' length.
    const detail::joined_wstring<A, B, C, Rest...> first(detail::wvalue(s1));
    return CONCAT(CONCAT(first, s2), s3, rest...);
}

/** INSERT(IN1, IN2, P): IN2 after the first P characters of IN1. */
template<typename A, typename B, typename = detail::if_wstring<A>, typename = detail::if_wstring<B>>
inline detail::joined_wstring<A, B> INSERT(const A& s1, const B& s2, size_t pos) noexcept {
    detail::joined_wstring<A, B> result(detail::wvalue(s1));
    if (pos > result.length()) pos = result.length();
    result.insert(pos, detail::wvalue(s2).c_str());
    return result;
}

template<typename S, typename = detail::if_wstring<S>>
inline detail::wstring_value_t<S> DELETE_STR(const S& s, size_t len, size_t pos) noexcept {
    return WDELETE(detail::wvalue(s), len, pos);
}

template<typename A, typename B, typename = detail::if_wstring<A>, typename = detail::if_wstring<B>>
inline detail::joined_wstring<A, B> REPLACE(const A& s1, const B& s2, size_t len, size_t pos) noexcept {
    detail::joined_wstring<A, B> result(detail::wvalue(s1));
    if (pos == 0) pos = 1;
    result.replace(pos - 1, len, detail::wvalue(s2).c_str());
    return result;
}

template<typename A, typename B, typename = detail::if_wstring<A>, typename = detail::if_wstring<B>>
inline size_t FIND(const A& s1, const B& s2) noexcept {
    return WFIND(detail::wvalue(s1), detail::wvalue(s2));
}

} // namespace strucpp
