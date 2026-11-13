// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2026 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - UNION storage (feature union)
 *
 * A generated UNION owns one zero-initialised byte buffer, sized and aligned
 * for the largest member's PLAIN value representation (REAL_t, not
 * IECVar<REAL_t>). Every member is a proxy object of the buffer's full size,
 * so all of them sit at the buffer's start; the member's offset is a template
 * argument. A read or write copies the member's bytes with memcpy, so writing
 * one member and reading another reinterprets the bytes (host byte order;
 * the documented target is little-endian).
 *
 *   - `union_traits<W>` maps the C++ type a STRUCT field of that IEC type has
 *     (W: IECVar<T>, IEC_ENUM_Var<E>, IECStringVar<N>, Array1D<...>, a
 *     generated STRUCT or UNION, a pointer) to its plain representation, its
 *     load/store, its in-place view and its pointer-based ref.
 *   - In-place views (`view<Off, Size>`) are the members of a UNION; refs are
 *     what a subscript with a run-time index returns.
 *   - `union_read(x)` yields a member's value as the field type W (const), so
 *     generated code sees what a STRUCT field read gives; `union_value(x)` is
 *     the same, non-const, for a VAR_IN_OUT copy-in temporary.
 *
 * Members carry no forcing state: a UNION member cannot be forced.
 *
 * STRING(N) / WSTRING(N) members are stored as a plain NUL-terminated
 * char[N+1] / char16_t[N+1]. A read stops at the first NUL or after N
 * characters, so bytes written through another member never give a length
 * beyond N.
 *
 * C++14 only (the runtime is compiled at -std=c++14).
 */

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#include <utility>

#include "iec_types.hpp"
#include "iec_var.hpp"
#include "iec_enum.hpp"
#include "iec_string.hpp"
#include "iec_wstring.hpp"
#include "iec_array.hpp"
#include "iec_fault.hpp"
#include "iec_ptr.hpp"
#include "iec_pointer.hpp"

namespace strucpp {

/** Plain representation, load/store, view and ref of a field type W. */
template<typename W, typename Enable = void>
struct union_traits;

template<typename W>
using union_plain_t = typename union_traits<W>::plain;
template<typename W, std::size_t Off, std::size_t Size>
using union_view_t = typename union_traits<W>::template view<Off, Size>;
template<typename W>
using union_ref_t = typename union_traits<W>::ref;

// =============================================================================
// Location policies: where a proxy's bytes are
// =============================================================================

/** In place: the proxy is the whole storage; its member starts at Off. */
template<std::size_t Off, std::size_t Size>
struct union_inplace {
    unsigned char union_bytes_[Size];
    unsigned char* union_addr() noexcept { return union_bytes_ + Off; }
    const unsigned char* union_addr() const noexcept { return union_bytes_ + Off; }
};

/** By pointer: what a run-time subscript returns. */
struct union_at {
    unsigned char* union_ptr_;
    unsigned char* union_addr() const noexcept { return union_ptr_; }
};

namespace detail {
template<typename Loc>
struct union_loc_init {
    static void set(Loc&, unsigned char*) noexcept {}
};
template<>
struct union_loc_init<union_at> {
    static void set(union_at& l, unsigned char* p) noexcept { l.union_ptr_ = p; }
};

[[noreturn]] inline void union_bounds_fault() {
#if STRUCPP_HAS_EXCEPTIONS
    throw std::out_of_range("Array index out of bounds");
#else
    iec_runtime_fault(IecFault::ArrayBounds);
#endif
}

template<typename P>
inline P union_load_bytes(const unsigned char* p) noexcept {
    P v;
    std::memcpy(static_cast<void*>(&v), p, sizeof(P));
    return v;
}

template<typename P>
inline void union_store_bytes(unsigned char* p, const P& v) noexcept {
    std::memcpy(p, static_cast<const void*>(&v), sizeof(P));
}

/** Plain storage of an array: N plain elements, no padding of its own. */
template<typename P, std::size_t N>
struct union_plain_array {
    P e[N];
};

/** Plain storage of a STRING(N) / WSTRING(N): NUL-terminated characters. */
template<typename C, std::size_t N>
struct union_plain_chars {
    C c[N + 1];
};

/** Characters before the first NUL, at most N. */
template<typename C>
inline std::size_t union_char_length(const unsigned char* p, std::size_t n) noexcept {
    std::size_t len = 0;
    while (len < n) {
        C ch;
        std::memcpy(&ch, p + len * sizeof(C), sizeof(C));
        if (ch == C(0)) break;
        ++len;
    }
    return len;
}
}  // namespace detail

/** True for the proxy types of this header and the generated UNION helpers. */
template<typename X, typename = void>
struct is_union_proxy : std::false_type {};
template<typename X>
struct is_union_proxy<X, typename X::union_proxy_tag> : std::true_type {};

// =============================================================================
// Scalar proxy: elementary, enumeration, STRING, pointer members
// =============================================================================

/**
 * A member whose value is one W. Reads build a W from the bytes; writes store
 * a W's plain value. Copy assignment copies the member's value only.
 */
template<typename W, typename Loc>
class union_scalar : public Loc {
    using traits = union_traits<W>;

public:
    using union_proxy_tag = void;
    using union_value_type = W;
    using union_plain_type = typename traits::plain;

    union_scalar() = default;
    union_scalar(const union_scalar&) = default;
    explicit union_scalar(unsigned char* p) noexcept {
        detail::union_loc_init<Loc>::set(*this, p);
    }

    W get() const noexcept { return traits::load(this->union_addr()); }

    /** The plain value (REAL_t, an enumeration, a pointer...), for built-in operators. */
    operator typename traits::scalar() const noexcept {
        return traits::to_scalar(get());
    }

    union_scalar& operator=(const W& v) noexcept {
        traits::store(const_cast<unsigned char*>(this->union_addr()), v);
        return *this;
    }
    union_scalar& operator=(const union_scalar& o) noexcept {
        return *this = o.get();
    }
    template<typename L2>
    union_scalar& operator=(const union_scalar<W, L2>& o) noexcept {
        return *this = o.get();
    }

    /** Dereference of a POINTER TO / REF_TO member: the target, not the member. */
    template<typename Q = W>
    auto operator*() const -> decltype(*std::declval<Q>()) {
        return *get();
    }

    /** ADR of a member: the address of its bytes. */
    union_plain_type* operator&() noexcept {
        return reinterpret_cast<union_plain_type*>(
            const_cast<unsigned char*>(this->union_addr()));
    }
};

namespace detail {
/** Scalar traits shared by the specialisations: plain P, field type W. */
template<typename W, typename P>
struct union_scalar_traits_base {
    using plain = P;
    using ref = union_scalar<W, union_at>;
    template<std::size_t Off, std::size_t Size>
    using view = union_scalar<W, union_inplace<Off, Size>>;
};
}  // namespace detail

/** Elementary member: IECVar<T>, stored as T. */
template<typename T>
struct union_traits<IECVar<T>, std::enable_if_t<!std::is_same<T, bool>::value>>
    : detail::union_scalar_traits_base<IECVar<T>, T> {
    using scalar = T;
    static IECVar<T> load(const unsigned char* p) noexcept {
        return IECVar<T>(detail::union_load_bytes<T>(p));
    }
    static void store(unsigned char* p, const IECVar<T>& v) noexcept {
        detail::union_store_bytes<T>(p, v.get());
    }
    static T to_scalar(const IECVar<T>& v) noexcept { return v.get(); }
};

/** BOOL member: one byte, any non-zero byte reads as TRUE. */
template<>
struct union_traits<IECVar<bool>, void>
    : detail::union_scalar_traits_base<IECVar<bool>, unsigned char> {
    using scalar = bool;
    static IECVar<bool> load(const unsigned char* p) noexcept {
        return IECVar<bool>(*p != 0);
    }
    static void store(unsigned char* p, const IECVar<bool>& v) noexcept {
        *p = v.get() ? 1 : 0;
    }
    static bool to_scalar(const IECVar<bool>& v) noexcept { return v.get(); }
};

/** Enumeration member: stored as the enumeration (its base type). */
template<typename E>
struct union_traits<IEC_ENUM_Var<E>, void>
    : detail::union_scalar_traits_base<IEC_ENUM_Var<E>, E> {
    using scalar = E;
    static IEC_ENUM_Var<E> load(const unsigned char* p) noexcept {
        return IEC_ENUM_Var<E>(detail::union_load_bytes<E>(p));
    }
    static void store(unsigned char* p, const IEC_ENUM_Var<E>& v) noexcept {
        detail::union_store_bytes<E>(p, static_cast<E>(v.get()));
    }
    static E to_scalar(const IEC_ENUM_Var<E>& v) noexcept {
        return static_cast<E>(v.get());
    }
};

/** STRING(N) member: plain NUL-terminated char[N+1]. */
template<std::size_t N>
struct union_traits<IECStringVar<N>, void>
    : detail::union_scalar_traits_base<IECStringVar<N>,
                                       detail::union_plain_chars<char, N>> {
    using scalar = IECString<N>;
    static IECStringVar<N> load(const unsigned char* p) noexcept {
        const std::size_t len = detail::union_char_length<char>(p, N);
        return IECStringVar<N>(
            IECString<N>(reinterpret_cast<const char*>(p), len));
    }
    static void store(unsigned char* p, const IECStringVar<N>& v) noexcept {
        const IECString<N> s = v.get();
        const std::size_t len = s.length() < N ? s.length() : N;
        std::memcpy(p, s.c_str(), len);
        p[len] = 0;
    }
    static IECString<N> to_scalar(const IECStringVar<N>& v) noexcept {
        return v.get();
    }
};

/** WSTRING(N) member: plain NUL-terminated char16_t[N+1]. */
template<std::size_t N>
struct union_traits<IECWStringVar<N>, void>
    : detail::union_scalar_traits_base<IECWStringVar<N>,
                                       detail::union_plain_chars<char16_t, N>> {
    using scalar = IECWString<N>;
    static IECWStringVar<N> load(const unsigned char* p) noexcept {
        const std::size_t len = detail::union_char_length<char16_t>(p, N);
        char16_t buf[N + 1];
        std::memcpy(buf, p, len * sizeof(char16_t));
        buf[len] = u'\0';
        return IECWStringVar<N>(IECWString<N>(buf, len));
    }
    static void store(unsigned char* p, const IECWStringVar<N>& v) noexcept {
        const IECWString<N> s = v.get();
        const std::size_t len = s.length() < N ? s.length() : N;
        std::memcpy(p, s.c_str(), len * sizeof(char16_t));
        const char16_t nul = u'\0';
        std::memcpy(p + len * sizeof(char16_t), &nul, sizeof(char16_t));
    }
    static IECWString<N> to_scalar(const IECWStringVar<N>& v) noexcept {
        return v.get();
    }
};

/** Member declared through an alias of an elementary or enumeration type (plain T). */
template<typename T>
struct union_traits<T, std::enable_if_t<(std::is_arithmetic<T>::value &&
                                         !std::is_same<T, bool>::value) ||
                                        std::is_enum<T>::value>>
    : detail::union_scalar_traits_base<T, T> {
    using scalar = T;
    static T load(const unsigned char* p) noexcept {
        return detail::union_load_bytes<T>(p);
    }
    static void store(unsigned char* p, const T& v) noexcept {
        detail::union_store_bytes<T>(p, v);
    }
    static T to_scalar(const T& v) noexcept { return v; }
};

/** Plain BOOL member: one byte, any non-zero byte reads as TRUE. */
template<>
struct union_traits<bool, void> : detail::union_scalar_traits_base<bool, unsigned char> {
    using scalar = bool;
    static bool load(const unsigned char* p) noexcept { return *p != 0; }
    static void store(unsigned char* p, const bool& v) noexcept { *p = v ? 1 : 0; }
    static bool to_scalar(const bool& v) noexcept { return v; }
};

/** POINTER TO member (a raw pointer to the target's storage). */
template<typename T>
struct union_traits<T*, void> : detail::union_scalar_traits_base<T*, T*> {
    using scalar = T*;
    static T* load(const unsigned char* p) noexcept {
        return detail::union_load_bytes<T*>(p);
    }
    static void store(unsigned char* p, T* const& v) noexcept {
        detail::union_store_bytes<T*>(p, v);
    }
    static T* to_scalar(T* v) noexcept { return v; }
};

namespace detail {
/** A POINTER TO / REF_TO object: one address, copied as its bytes. */
template<typename R>
struct union_address_traits : union_scalar_traits_base<R, R> {
    static_assert(std::is_trivially_copyable<R>::value,
                  "a reference in a UNION must be trivially copyable");
    using scalar = R;
    static R load(const unsigned char* p) noexcept { return union_load_bytes<R>(p); }
    static void store(unsigned char* p, const R& v) noexcept { union_store_bytes<R>(p, v); }
    static R to_scalar(const R& v) noexcept { return v; }
};
}  // namespace detail

/** REF_TO member. */
template<typename T>
struct union_traits<IEC_REF_TO<T>, void> : detail::union_address_traits<IEC_REF_TO<T>> {};

/** POINTER TO element of an array member. */
template<typename T>
struct union_traits<IEC_Ptr<T>, void> : detail::union_address_traits<IEC_Ptr<T>> {};

// =============================================================================
// Array proxies (Array1D / Array2D / Array3D members)
// =============================================================================

/** A 1-D array member; at() returns the element's ref. */
template<typename W, std::int64_t L, std::int64_t U, typename Loc>
class union_array1 : public Loc {
    using elem = union_traits<W>;
    using array_type = Array1D<W, L, U>;

public:
    using union_proxy_tag = void;
    using union_value_type = array_type;
    using union_plain_type = union_plain_t<array_type>;

    union_array1() = default;
    union_array1(const union_array1&) = default;
    explicit union_array1(unsigned char* p) noexcept {
        detail::union_loc_init<Loc>::set(*this, p);
    }

    union_ref_t<W> operator[](std::int64_t i) const noexcept {
        return union_ref_t<W>(element(i));
    }
    union_ref_t<W> at(std::int64_t i) const {
        if (i < L || i > U) detail::union_bounds_fault();
        return union_ref_t<W>(element(i));
    }
    static constexpr std::int64_t lower_bound(int = 1) noexcept { return L; }
    static constexpr std::int64_t upper_bound(int = 1) noexcept { return U; }
    static constexpr std::size_t length() noexcept {
        return static_cast<std::size_t>(U - L + 1);
    }

    array_type get() const noexcept {
        return union_traits<array_type>::load(this->union_addr());
    }
    operator array_type() const noexcept { return get(); }
    union_array1& operator=(const array_type& v) noexcept {
        union_traits<array_type>::store(base(), v);
        return *this;
    }
    union_array1& operator=(const union_array1& o) noexcept { return *this = o.get(); }

    union_plain_type* operator&() noexcept {
        return reinterpret_cast<union_plain_type*>(base());
    }

private:
    unsigned char* base() const noexcept {
        return const_cast<unsigned char*>(this->union_addr());
    }
    unsigned char* element(std::int64_t i) const noexcept {
        return base() + static_cast<std::size_t>(i - L) * sizeof(typename elem::plain);
    }
};

/** A 2-D array member (row-major, as Array2D). */
template<typename W, std::int64_t L1, std::int64_t U1, std::int64_t L2,
         std::int64_t U2, typename Loc>
class union_array2 : public Loc {
    using elem = union_traits<W>;
    using array_type = Array2D<W, L1, U1, L2, U2>;
    static constexpr std::int64_t cols = U2 - L2 + 1;

public:
    using union_proxy_tag = void;
    using union_value_type = array_type;
    using union_plain_type = union_plain_t<array_type>;

    union_array2() = default;
    union_array2(const union_array2&) = default;
    explicit union_array2(unsigned char* p) noexcept {
        detail::union_loc_init<Loc>::set(*this, p);
    }

    union_ref_t<W> operator()(std::int64_t i, std::int64_t j) const noexcept {
        return union_ref_t<W>(element(i, j));
    }
    union_ref_t<W> at(std::int64_t i, std::int64_t j) const {
        if (i < L1 || i > U1 || j < L2 || j > U2) detail::union_bounds_fault();
        return union_ref_t<W>(element(i, j));
    }
    static constexpr std::int64_t lower_bound(int dim = 1) noexcept { return dim == 2 ? L2 : L1; }
    static constexpr std::int64_t upper_bound(int dim = 1) noexcept { return dim == 2 ? U2 : U1; }

    array_type get() const noexcept {
        return union_traits<array_type>::load(this->union_addr());
    }
    operator array_type() const noexcept { return get(); }
    union_array2& operator=(const array_type& v) noexcept {
        union_traits<array_type>::store(base(), v);
        return *this;
    }
    union_array2& operator=(const union_array2& o) noexcept { return *this = o.get(); }

    union_plain_type* operator&() noexcept {
        return reinterpret_cast<union_plain_type*>(base());
    }

private:
    unsigned char* base() const noexcept {
        return const_cast<unsigned char*>(this->union_addr());
    }
    unsigned char* element(std::int64_t i, std::int64_t j) const noexcept {
        const std::size_t idx = static_cast<std::size_t>((i - L1) * cols + (j - L2));
        return base() + idx * sizeof(typename elem::plain);
    }
};

/** A 3-D array member (row-major, as Array3D). */
template<typename W, std::int64_t L1, std::int64_t U1, std::int64_t L2,
         std::int64_t U2, std::int64_t L3, std::int64_t U3, typename Loc>
class union_array3 : public Loc {
    using elem = union_traits<W>;
    using array_type = Array3D<W, L1, U1, L2, U2, L3, U3>;
    static constexpr std::int64_t d2 = U2 - L2 + 1;
    static constexpr std::int64_t d3 = U3 - L3 + 1;

public:
    using union_proxy_tag = void;
    using union_value_type = array_type;
    using union_plain_type = union_plain_t<array_type>;

    union_array3() = default;
    union_array3(const union_array3&) = default;
    explicit union_array3(unsigned char* p) noexcept {
        detail::union_loc_init<Loc>::set(*this, p);
    }

    union_ref_t<W> operator()(std::int64_t i, std::int64_t j, std::int64_t k) const noexcept {
        return union_ref_t<W>(element(i, j, k));
    }
    union_ref_t<W> at(std::int64_t i, std::int64_t j, std::int64_t k) const {
        if (i < L1 || i > U1 || j < L2 || j > U2 || k < L3 || k > U3) {
            detail::union_bounds_fault();
        }
        return union_ref_t<W>(element(i, j, k));
    }
    static constexpr std::int64_t lower_bound(int dim = 1) noexcept {
        return dim == 3 ? L3 : dim == 2 ? L2 : L1;
    }
    static constexpr std::int64_t upper_bound(int dim = 1) noexcept {
        return dim == 3 ? U3 : dim == 2 ? U2 : U1;
    }

    array_type get() const noexcept {
        return union_traits<array_type>::load(this->union_addr());
    }
    operator array_type() const noexcept { return get(); }
    union_array3& operator=(const array_type& v) noexcept {
        union_traits<array_type>::store(base(), v);
        return *this;
    }
    union_array3& operator=(const union_array3& o) noexcept { return *this = o.get(); }

    union_plain_type* operator&() noexcept {
        return reinterpret_cast<union_plain_type*>(base());
    }

private:
    unsigned char* base() const noexcept {
        return const_cast<unsigned char*>(this->union_addr());
    }
    unsigned char* element(std::int64_t i, std::int64_t j, std::int64_t k) const noexcept {
        const std::size_t idx =
            static_cast<std::size_t>(((i - L1) * d2 + (j - L2)) * d3 + (k - L3));
        return base() + idx * sizeof(typename elem::plain);
    }
};

namespace detail {
/** Load/store of every element of an array, in storage order. */
template<typename W, typename Array>
struct union_array_io {
    using P = union_plain_t<W>;
    static Array load(const unsigned char* p) noexcept {
        Array a;
        std::size_t i = 0;
        for (auto& e : a) {
            e = union_traits<W>::load(p + i * sizeof(P));
            ++i;
        }
        return a;
    }
    static void store(unsigned char* p, const Array& a) noexcept {
        std::size_t i = 0;
        for (const auto& e : a) {
            union_traits<W>::store(p + i * sizeof(P), e);
            ++i;
        }
    }
};
}  // namespace detail

template<typename W, std::int64_t L, std::int64_t U>
struct union_traits<IEC_ARRAY_1D<W, ArrayBounds<L, U>>, void>
    : detail::union_array_io<W, Array1D<W, L, U>> {
    using plain = detail::union_plain_array<union_plain_t<W>,
                                            static_cast<std::size_t>(U - L + 1)>;
    using ref = union_array1<W, L, U, union_at>;
    template<std::size_t Off, std::size_t Size>
    using view = union_array1<W, L, U, union_inplace<Off, Size>>;
};

template<typename W, std::int64_t L1, std::int64_t U1, std::int64_t L2, std::int64_t U2>
struct union_traits<IEC_ARRAY_2D<W, ArrayBounds<L1, U1>, ArrayBounds<L2, U2>>, void>
    : detail::union_array_io<W, Array2D<W, L1, U1, L2, U2>> {
    using plain = detail::union_plain_array<
        union_plain_t<W>, static_cast<std::size_t>((U1 - L1 + 1) * (U2 - L2 + 1))>;
    using ref = union_array2<W, L1, U1, L2, U2, union_at>;
    template<std::size_t Off, std::size_t Size>
    using view = union_array2<W, L1, U1, L2, U2, union_inplace<Off, Size>>;
};

template<typename W, std::int64_t L1, std::int64_t U1, std::int64_t L2, std::int64_t U2,
         std::int64_t L3, std::int64_t U3>
struct union_traits<IEC_ARRAY_3D<W, ArrayBounds<L1, U1>, ArrayBounds<L2, U2>,
                                 ArrayBounds<L3, U3>>, void>
    : detail::union_array_io<W, Array3D<W, L1, U1, L2, U2, L3, U3>> {
    using plain = detail::union_plain_array<
        union_plain_t<W>,
        static_cast<std::size_t>((U1 - L1 + 1) * (U2 - L2 + 1) * (U3 - L3 + 1))>;
    using ref = union_array3<W, L1, U1, L2, U2, L3, U3, union_at>;
    template<std::size_t Off, std::size_t Size>
    using view = union_array3<W, L1, U1, L2, U2, L3, U3, union_inplace<Off, Size>>;
};

// =============================================================================
// Reads
// =============================================================================

/** A member's value as its field type, const: a write to it does not compile. */
template<typename X, std::enable_if_t<is_union_proxy<X>::value, int> = 0>
inline const typename X::union_value_type union_read(const X& x) noexcept {
    return x.get();
}

/** Anything else (a bit of a member, a value already read) passes through. */
template<typename X, std::enable_if_t<!is_union_proxy<X>::value, int> = 0>
inline const X& union_read(const X& x) noexcept {
    return x;
}

/** A member's value as a modifiable temporary (VAR_IN_OUT copy-in). */
template<typename X, std::enable_if_t<is_union_proxy<X>::value, int> = 0>
inline typename X::union_value_type union_value(const X& x) noexcept {
    return x.get();
}

}  // namespace strucpp
