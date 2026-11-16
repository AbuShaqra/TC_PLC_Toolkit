// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Pointer Type
 *
 * Provides IEC_Ptr<T>, a smart pointer wrapper that handles the type-punning
 * semantics of IEC 61131-3 POINTER TO. In CODESYS, POINTER TO BYTE is commonly
 * used as a universal memory pointer (like void*) and ADR() can return any
 * address that is freely assigned to any pointer type.
 *
 * IEC_Ptr<T> stores a void* internally and provides:
 * - Construction/assignment from any pointer type (cross-type OK)
 * - Construction/assignment from other IEC_Ptr<U> (cross-type OK)
 * - Dereference as T& / T*
 * - Pointer arithmetic in units of sizeof(T)
 * - Conversion to integral types (for CODESYS-style address math)
 * - Comparison operators (same-type and cross-type)
 */

#pragma once

#include <cstdint>
#include <cstddef>
#include <type_traits>

#include "iec_types.hpp"
#include "iec_fault.hpp"   // STRUCPP_HAS_EXCEPTIONS, IecFault, iec_runtime_fault
#if STRUCPP_HAS_EXCEPTIONS
#include <stdexcept>
#endif

namespace strucpp {

// Forward declare IECVar for arithmetic overloads
template<typename T> class IECVar;

namespace detail {
/**
 * What a POINTER TO T dereferences as: T marked STRUCPP_MAY_ALIAS when T is a
 * scalar, so `POINTER TO DWORD` over a REAL is not reordered by alias
 * analysis. A class pointee (an array, a STRUCT) is left as it is: the
 * attribute cannot be added to a defined class, and its elementary members
 * already carry it.
 */
template<typename T, bool IsClass = std::is_class<T>::value>
struct ptr_alias { typedef T STRUCPP_MAY_ALIAS type; };
template<typename T>
struct ptr_alias<T, true> { typedef T type; };
}  // namespace detail

template<typename T>
class IEC_Ptr {
    void* ptr_;
public:
    using element_type = T;
    /** The type a dereference yields; see detail::ptr_alias. */
    using ref_type = typename detail::ptr_alias<T>::type;

    // Constructors
    IEC_Ptr() noexcept : ptr_(nullptr) {}
    IEC_Ptr(std::nullptr_t) noexcept : ptr_(nullptr) {}

    // Construct from any raw pointer
    template<typename U>
    IEC_Ptr(U* p) noexcept : ptr_(const_cast<void*>(static_cast<const volatile void*>(p))) {}

    // Construct from another IEC_Ptr (cross-type)
    template<typename U>
    IEC_Ptr(IEC_Ptr<U> other) noexcept : ptr_(other.get_void()) {}

    // Construct from an integer address (e.g. __XWORD/ULINT from ADR()).
    // `IEC_XWORD` implicitly converts to its underlying integer, which
    // converts to uintptr_t here — the typed pointer round-trips the address.
    explicit IEC_Ptr(std::uintptr_t addr) noexcept
        : ptr_(reinterpret_cast<void*>(addr)) {}

    // Assignment from any raw pointer
    template<typename U>
    IEC_Ptr& operator=(U* p) noexcept {
        ptr_ = const_cast<void*>(static_cast<const volatile void*>(p));
        return *this;
    }

    // Assignment from another IEC_Ptr (cross-type)
    template<typename U>
    IEC_Ptr& operator=(IEC_Ptr<U> other) noexcept {
        ptr_ = other.get_void();
        return *this;
    }

    IEC_Ptr& operator=(std::nullptr_t) noexcept {
        ptr_ = nullptr;
        return *this;
    }

    // Assignment from an integer address (e.g. `ptr := _TMP` where the temp is
    // __XWORD/ULINT from ADR()). The address is reinterpreted to the typed
    // pointer; the source integer carries a pointer-width value.
    IEC_Ptr& operator=(std::uintptr_t addr) noexcept {
        ptr_ = reinterpret_cast<void*>(addr);
        return *this;
    }

    // Null-fault helper: a dereference of an unassigned (NULL) POINTER TO
    // raises a clean fault instead of an undefined access — throw on exception
    // targets (the runtime catches it and stops just the faulting task), or
    // iec_runtime_fault(IecFault::NullReference) on -fno-exceptions MCU targets
    // (where there is no MMU to trap a null deref, so the unchecked access would
    // silently read/write address 0). Mirrors REF_TO's NullReferenceException.
    void __fault_if_null() const {
#ifndef STRUCPP_NO_BOUNDS_CHECK
        if (!ptr_) {
#if STRUCPP_HAS_EXCEPTIONS
            throw std::runtime_error("Null pointer dereference");
#else
            iec_runtime_fault(IecFault::NullReference);
#endif
        }
#endif
    }

    // Dereference (null-checked)
    ref_type& operator*() const { __fault_if_null(); return *static_cast<ref_type*>(ptr_); }
    T* operator->() const { __fault_if_null(); return static_cast<T*>(ptr_); }

    // Subscript (pointer[n]) — null-checked base (the offset itself is
    // unbounded raw pointer arithmetic, as in C).
    ref_type& operator[](std::ptrdiff_t n) const {
        __fault_if_null();
        return *(static_cast<ref_type*>(ptr_) + n);
    }

    // Bounds-checked accessor used by codegen's subscript path. A POINTER TO has
    // no bounds metadata, so this matches operator[]: null-checked base with
    // unbounded raw pointer arithmetic (as in C).
    ref_type& at(std::ptrdiff_t n) const {
        __fault_if_null();
        return *(static_cast<ref_type*>(ptr_) + n);
    }

    // Raw access
    T* get() const noexcept { return static_cast<T*>(ptr_); }

    /** The address `n` bytes after this one (before it when `n` is negative). */
    T* bytes(std::ptrdiff_t n) const noexcept {
        return reinterpret_cast<T*>(static_cast<char*>(ptr_) + n);
    }
    void* get_void() const noexcept { return ptr_; }

    // Pointer arithmetic counts bytes, as on a PLC: `p + 2` moves 2 bytes,
    // whatever T is. Use templates to directly match any arithmetic type,
    // avoiding ambiguity with the integral conversion operator.
    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr operator+(N n) const noexcept {
        return IEC_Ptr(bytes(static_cast<std::ptrdiff_t>(n)));
    }

    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr operator-(N n) const noexcept {
        return IEC_Ptr(bytes(-static_cast<std::ptrdiff_t>(n)));
    }

    // Arithmetic with IECVar-wrapped types (unwrap the value)
    template<typename U>
    IEC_Ptr operator+(const IECVar<U>& n) const noexcept {
        return IEC_Ptr(bytes(static_cast<std::ptrdiff_t>(n.get())));
    }

    template<typename U>
    IEC_Ptr operator-(const IECVar<U>& n) const noexcept {
        return IEC_Ptr(bytes(-static_cast<std::ptrdiff_t>(n.get())));
    }

    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr& operator+=(N n) noexcept {
        ptr_ = bytes(static_cast<std::ptrdiff_t>(n));
        return *this;
    }

    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr& operator-=(N n) noexcept {
        ptr_ = bytes(-static_cast<std::ptrdiff_t>(n));
        return *this;
    }

    // Pre/post increment/decrement
    IEC_Ptr& operator++() noexcept {
        ptr_ = static_cast<T*>(ptr_) + 1;
        return *this;
    }

    IEC_Ptr operator++(int) noexcept {
        IEC_Ptr tmp = *this;
        ptr_ = static_cast<T*>(ptr_) + 1;
        return tmp;
    }

    IEC_Ptr& operator--() noexcept {
        ptr_ = static_cast<T*>(ptr_) - 1;
        return *this;
    }

    IEC_Ptr operator--(int) noexcept {
        IEC_Ptr tmp = *this;
        ptr_ = static_cast<T*>(ptr_) - 1;
        return tmp;
    }

    // Conversion to integral types (for CODESYS pointer-to-DWORD patterns)
    // This enables: DWORD_VAR := PT; (store address as integer)
    // Must NOT be implicit to avoid ambiguity with operator+ etc.
    // Use to_addr() for explicit conversion instead.
    uintptr_t to_addr() const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_);
    }

    // Conversion to bool (for null checks)
    explicit operator bool() const noexcept { return ptr_ != nullptr; }

    // Same-type comparison
    bool operator==(IEC_Ptr other) const noexcept { return ptr_ == other.ptr_; }
    bool operator!=(IEC_Ptr other) const noexcept { return ptr_ != other.ptr_; }
    bool operator<(IEC_Ptr other) const noexcept { return ptr_ < other.ptr_; }
    bool operator>(IEC_Ptr other) const noexcept { return ptr_ > other.ptr_; }
    bool operator<=(IEC_Ptr other) const noexcept { return ptr_ <= other.ptr_; }
    bool operator>=(IEC_Ptr other) const noexcept { return ptr_ >= other.ptr_; }

    // Cross-type IEC_Ptr comparison
    template<typename U>
    bool operator==(IEC_Ptr<U> other) const noexcept { return ptr_ == other.get_void(); }
    template<typename U>
    bool operator!=(IEC_Ptr<U> other) const noexcept { return ptr_ != other.get_void(); }
    template<typename U>
    bool operator<(IEC_Ptr<U> other) const noexcept { return ptr_ < other.get_void(); }
    template<typename U>
    bool operator>(IEC_Ptr<U> other) const noexcept { return ptr_ > other.get_void(); }
    template<typename U>
    bool operator<=(IEC_Ptr<U> other) const noexcept { return ptr_ <= other.get_void(); }
    template<typename U>
    bool operator>=(IEC_Ptr<U> other) const noexcept { return ptr_ >= other.get_void(); }

    // Comparison with nullptr
    bool operator==(std::nullptr_t) const noexcept { return ptr_ == nullptr; }
    bool operator!=(std::nullptr_t) const noexcept { return ptr_ != nullptr; }

    // Comparison with IECVar<integer> (for CODESYS: PT < DWORD_END)
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator<(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) < static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator>(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) > static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator<=(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) <= static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator>=(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) >= static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator==(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) == static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator!=(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) != static_cast<uintptr_t>(other.get());
    }
};

/**
 * After a function block is copied: when `src` (of `other`) points into
 * `other`, `p` (of `self`) points to the same place in `self`.
 */
template<typename T, typename Owner>
inline void rebind_own_member(IEC_Ptr<T>& p, const IEC_Ptr<T>& src,
                              Owner* self, const Owner* other) noexcept {
    const char* bound = static_cast<const char*>(src.get_void());
    const char* from = reinterpret_cast<const char*>(other);
    if (bound == nullptr || bound < from || bound >= from + sizeof(Owner)) return;
    p = IEC_Ptr<T>(static_cast<void*>(reinterpret_cast<char*>(self) + (bound - from)));
}

/** The same for each element of an ARRAY of pointers. */
template<typename A, typename Owner>
inline auto rebind_own_member(A& arr, const A& src, Owner* self,
                              const Owner* other) noexcept
    -> decltype(arr.begin(), src.begin(), void()) {
    auto to = arr.begin();
    for (auto from = src.begin(); from != src.end(); ++from, ++to) {
        rebind_own_member(*to, *from, self, other);
    }
}

// Reverse comparison: nullptr == IEC_Ptr
template<typename T>
bool operator==(std::nullptr_t, IEC_Ptr<T> p) noexcept { return p == nullptr; }
template<typename T>
bool operator!=(std::nullptr_t, IEC_Ptr<T> p) noexcept { return p != nullptr; }

// Arithmetic: n + ptr (reverse order)
template<typename T>
IEC_Ptr<T> operator+(std::ptrdiff_t n, IEC_Ptr<T> p) noexcept { return p + n; }

// ADR arithmetic counts bytes, as on a PLC: `ADR(x) + 2 + 2` is 4 bytes after x,
// `ADR(a) - ADR(b)` the bytes between them. The code generator works on the
// address as an integer and converts the total back.

/** An address, as a count of bytes. */
template<typename T>
inline std::uintptr_t iec_byte_addr(T* p) noexcept {
    return reinterpret_cast<std::uintptr_t>(p);
}

/** A byte offset added to or taken from an address. */
template<typename N>
inline std::uintptr_t iec_byte_offset(const N& n) noexcept {
    return static_cast<std::uintptr_t>(static_cast<std::intptr_t>(n));
}

} // namespace strucpp
