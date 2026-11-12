// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Reference Types (REF_TO, REFERENCE_TO)
 *
 * This header provides IEC 61131-3 reference types:
 * - REF_TO: Explicit-dereference reference (nullable pointer)
 * - REFERENCE_TO: Implicit-dereference reference (CODESYS compatibility)
 * - REF() operator to get reference to a variable
 * - NULL value for uninitialized REF_TO
 * - NullReferenceException for null dereference errors
 *
 * Design decisions:
 * - References are NOT forceable (unlike IECVar<T>)
 * - Writes through references land in the target; a forced target gets its
 *   forced value back at the next cycle boundary (iec_force.hpp)
 * - Null dereference throws NullReferenceException
 * - REFERENCE_TO cannot be NULL (must always be bound)
 *
 * Example ST code (REF_TO):
 *   VAR
 *       V1, V2 : INT;
 *       rV : REF_TO INT;
 *   END_VAR
 *
 *   rV := REF(V2);      // Get reference to V2
 *   rV^ := 12;          // Assign 12 to V2 via reference
 *   V1 := rV^;          // Read V2 via reference
 *
 *   IF rV <> NULL THEN  // Null check
 *       rV^ := 42;
 *   END_IF;
 *
 * Example ST code (REFERENCE_TO):
 *   VAR
 *       target : INT := 10;
 *       ref : REFERENCE_TO INT := target;  // Must be initialized
 *   END_VAR
 *
 *   ref := 42;          // Implicit write to target
 *   x := ref;           // Implicit read from target
 *   ref REF= other;     // Rebind to different variable
 */

#pragma once

#include <cstddef>
#include <type_traits>
#include "iec_fault.hpp"
#if STRUCPP_HAS_EXCEPTIONS
#include <stdexcept>
#include <string>
#endif
#include "iec_var.hpp"

namespace strucpp {

// =============================================================================
// Null Reference Exception
// =============================================================================

#if STRUCPP_HAS_EXCEPTIONS
/**
 * Exception thrown when dereferencing a NULL reference.
 * The runtime catches this and stops execution of the affected POU.
 */
class NullReferenceException : public std::runtime_error {
public:
    NullReferenceException()
        : std::runtime_error("Null reference dereference") {}

    explicit NullReferenceException(const char* context)
        : std::runtime_error(std::string("Null reference dereference in ") + context) {}

    explicit NullReferenceException(const std::string& context)
        : std::runtime_error("Null reference dereference in " + context) {}
};
#endif

// =============================================================================
// IEC NULL Constant
// =============================================================================

/**
 * IEC NULL pointer constant.
 * Used to indicate no address / uninitialized pointer.
 */
constexpr std::nullptr_t IEC_NULL = nullptr;

// =============================================================================
// REF_TO Type (Explicit Dereference)
// =============================================================================

template<typename T> class IEC_REF_TO;
template<typename T> class IEC_REFERENCE_TO;
template<typename T> class IEC_Ptr;

template<size_t MaxLen> class IECString;
template<size_t MaxLen> class IECWString;
template<size_t MaxLen> class IECStringVar;
template<size_t MaxLen> class IECWStringVar;
template<typename EnumType> class IEC_ENUM_Var;

namespace detail {
/**
 * T is a class a variable holds as itself, not in an IECVar<T>: a STRUCT or
 * a function block (a string value, an IECVar or a reference wrapper is not).
 */
template<typename T> struct stored_directly : std::is_class<T> {};
template<typename U> struct stored_directly<IECVar<U>> : std::false_type {};
template<size_t N> struct stored_directly<IECString<N>> : std::false_type {};
template<size_t N> struct stored_directly<IECWString<N>> : std::false_type {};
template<size_t N> struct stored_directly<IECStringVar<N>> : std::false_type {};
template<size_t N> struct stored_directly<IECWStringVar<N>> : std::false_type {};
template<typename U> struct stored_directly<IEC_REF_TO<U>> : std::false_type {};
template<typename U> struct stored_directly<IEC_REFERENCE_TO<U>> : std::false_type {};
template<typename U> struct stored_directly<IEC_Ptr<U>> : std::false_type {};
template<typename E> struct stored_directly<IEC_ENUM_Var<E>> : std::false_type {};

/**
 * The variable holding a T: T itself when stored directly, IECStringVar /
 * IECWStringVar for a string, IEC_ENUM_Var for an enumeration, else IECVar<T>.
 */
template<typename T, bool IsEnum = std::is_enum<T>::value> struct value_target {
    using type = typename std::conditional<stored_directly<T>::value, T, IECVar<T>>::type;
};
template<typename T> struct value_target<T, true> { using type = IEC_ENUM_Var<T>; };
template<size_t N> struct value_target<IECString<N>, false> { using type = IECStringVar<N>; };
template<size_t N> struct value_target<IECWString<N>, false> { using type = IECWStringVar<N>; };

/**
 * The object a REF_TO T points at. A value lives in an IECVar<T>, a STRUCT or
 * function block in itself; a reference or pointer variable is the
 * IEC_REF_TO / IEC_REFERENCE_TO / IEC_Ptr object itself, so REF_TO REF_TO INT
 * points at an IEC_REF_TO<INT_t>.
 */
template<typename T> struct ref_target { using type = typename value_target<T>::type; };
template<typename U> struct ref_target<IEC_REF_TO<U>> { using type = IEC_REF_TO<U>; };
template<typename U> struct ref_target<IEC_REFERENCE_TO<U>> { using type = IEC_REFERENCE_TO<U>; };
template<typename U> struct ref_target<IEC_Ptr<U>> { using type = IEC_Ptr<U>; };
}  // namespace detail

/**
 * REF_TO pointer type for IEC 61131-3.
 * Wraps a pointer to an IECVar<T> with null checking.
 *
 * Note: References themselves are NOT forceable.
 * Writes through references land in the target, as any write does.
 *
 * @tparam T The underlying value type (e.g., INT_t, REAL_t)
 */
template<typename T>
class IEC_REF_TO {
public:
    using value_type = T;
    /** What the reference points at: IECVar<T>, or T itself for a reference or pointer. */
    using target_type = typename detail::ref_target<T>::type;
    using pointer_type = target_type*;

private:
    pointer_type ptr_;

public:
    /**
     * Default constructor - initializes to NULL
     */
    IEC_REF_TO() noexcept : ptr_(nullptr) {}

    /**
     * Constructor from pointer to IECVar
     */
    explicit IEC_REF_TO(pointer_type p) noexcept : ptr_(p) {}

    /**
     * Constructor from nullptr (NULL)
     */
    IEC_REF_TO(std::nullptr_t) noexcept : ptr_(nullptr) {}

    /**
     * Constructor from an integer address (e.g. a __XWORD temp produced by
     * REF_LINK()). The address is reinterpreted as the wrapped IECVar<T>*;
     * it must originate from REF_LINK()/ADR() of a matching variable.
     */
    explicit IEC_REF_TO(std::uintptr_t addr) noexcept
        : ptr_(reinterpret_cast<pointer_type>(addr)) {}

    // Copy and move constructors/assignment - default is fine
    IEC_REF_TO(const IEC_REF_TO&) = default;
    IEC_REF_TO(IEC_REF_TO&&) = default;
    IEC_REF_TO& operator=(const IEC_REF_TO&) = default;
    IEC_REF_TO& operator=(IEC_REF_TO&&) = default;

    /**
     * Get the pointer (for internal use)
     */
    pointer_type get() const noexcept { return ptr_; }

    /**
     * Set the pointer
     */
    void set(pointer_type p) noexcept { ptr_ = p; }

    /**
     * Check if pointer is NULL
     */
    bool is_null() const noexcept { return ptr_ == nullptr; }

    /**
     * Dereference - throws NullReferenceException if NULL
     * Used by generated code for ^ operator and DREF() function
     */
    target_type& deref() {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException();
#else
            iec_runtime_fault(IecFault::NullReference);
#endif
        }
        return *ptr_;
    }

    const target_type& deref() const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException();
#else
            iec_runtime_fault(IecFault::NullReference);
#endif
        }
        return *ptr_;
    }

    /**
     * Dereference with context for better error messages
     */
    target_type& deref(const char* context) {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException(context);
#else
            iec_runtime_fault(IecFault::NullReference, context);
#endif
        }
        return *ptr_;
    }

    const target_type& deref(const char* context) const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException(context);
#else
            iec_runtime_fault(IecFault::NullReference, context);
#endif
        }
        return *ptr_;
    }

    // =========================================================================
    // Operators
    // =========================================================================

    /**
     * Assignment from pointer
     */
    IEC_REF_TO& operator=(pointer_type p) noexcept {
        set(p);
        return *this;
    }

    /**
     * Assignment from nullptr (NULL)
     */
    IEC_REF_TO& operator=(std::nullptr_t) noexcept {
        set(nullptr);
        return *this;
    }

    /**
     * Assignment from an integer address (e.g. `ref := _TMP` where the temp is
     * a __XWORD produced by REF_LINK()). The address is reinterpreted as the
     * wrapped IECVar<T>*.
     */
    IEC_REF_TO& operator=(std::uintptr_t addr) noexcept {
        set(reinterpret_cast<pointer_type>(addr));
        return *this;
    }

    /**
     * Dereference operator (*) - same as deref()
     */
    target_type& operator*() {
        return deref();
    }

    const target_type& operator*() const {
        return deref();
    }

    /**
     * Arrow operator for accessing IECVar methods
     * Also throws NullReferenceException if NULL
     */
    pointer_type operator->() {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException();
#else
            iec_runtime_fault(IecFault::NullReference);
#endif
        }
        return ptr_;
    }

    const target_type* operator->() const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException();
#else
            iec_runtime_fault(IecFault::NullReference);
#endif
        }
        return ptr_;
    }

    /**
     * Comparison with nullptr (NULL)
     */
    bool operator==(std::nullptr_t) const noexcept {
        return is_null();
    }

    bool operator!=(std::nullptr_t) const noexcept {
        return !is_null();
    }

    /**
     * Comparison with another pointer
     */
    bool operator==(const IEC_REF_TO& other) const noexcept {
        return ptr_ == other.ptr_;
    }

    bool operator!=(const IEC_REF_TO& other) const noexcept {
        return ptr_ != other.ptr_;
    }

    /**
     * Implicit conversion to bool (for null checks)
     * Returns true if pointer is not NULL
     */
    explicit operator bool() const noexcept {
        return !is_null();
    }
};

// =============================================================================
// REFERENCE_TO Type (Implicit Dereference)
// =============================================================================

/**
 * REFERENCE_TO type with implicit dereferencing.
 * Unlike REF_TO, this type automatically dereferences on value access.
 *
 * Conceptually always bound; default-constructs unbound (nullptr) only so
 * the variable can be declared before being bound. Must be bound (via the
 * REF= operator / bind(), or by the call for a VAR_INPUT) before any read or
 * write — accessing it unbound raises the NullReference fault, as a NULL
 * REF_TO dereference does.
 *
 * @tparam T The underlying value type (e.g., INT_t, REAL_t)
 */
template<typename T>
class IEC_REFERENCE_TO {
public:
    using value_type = T;
    /** What the reference is bound to: IECVar<T>, or a STRUCT / function block itself. */
    using target_type = typename detail::value_target<T>::type;
    using pointer_type = target_type*;

private:
    pointer_type ptr_;

public:
    /**
     * Default constructor - unbound (ptr_ == nullptr).
     *
     * IEC 61131-3 REFERENCE TO is conceptually "always bound", but a
     * variable of this type must still be *declarable* before it is bound
     * (e.g. an uninitialized FB member or local that is bound later via the
     * REF= operator inside the POU body, or an FB input bound by a call).
     * The generated code default-constructs such members, so a usable
     * default ctor is required.
     *
     * Reading or writing an unbound REFERENCE TO raises the NullReference
     * fault (see bound()).
     */
    IEC_REFERENCE_TO() noexcept : ptr_(nullptr) {}

    /**
     * Constructor - initialize bound to a variable (REFERENCE TO X := target)
     */
    explicit IEC_REFERENCE_TO(target_type& var) noexcept : ptr_(&var) {}

    // Copy/move - default is fine
    IEC_REFERENCE_TO(const IEC_REFERENCE_TO&) = default;
    IEC_REFERENCE_TO(IEC_REFERENCE_TO&&) = default;
    IEC_REFERENCE_TO& operator=(const IEC_REFERENCE_TO&) = default;
    IEC_REFERENCE_TO& operator=(IEC_REFERENCE_TO&&) = default;

    /**
     * Bind to a new variable (REF= operator)
     */
    void bind(target_type& var) noexcept { ptr_ = &var; }

    /**
     * Bind to what another reference is bound to (REF= from a reference).
     */
    void bind(const IEC_REFERENCE_TO& other) noexcept { ptr_ = other.ptr_; }

    /**
     * Check if the reference is unbound
     */
    bool is_null() const noexcept { return ptr_ == nullptr; }

    /**
     * Implicit value access (get) - reads from target
     */
    T get() const { return bound().get(); }

    /**
     * Implicit value assignment (set) - writes to target
     * Writes the target, as any write does
     */
    void set(const T& value) { bound().set(value); }

    /**
     * Get underlying IECVar reference
     */
    target_type& target() { return bound(); }
    const target_type& target() const { return bound(); }

private:
    /**
     * The bound target; an unbound reference raises the NullReference fault
     */
    target_type& bound() const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException("REFERENCE TO");
#else
            iec_runtime_fault(IecFault::NullReference, "REFERENCE TO");
#endif
        }
        return *ptr_;
    }

public:

    // =========================================================================
    // Operators
    // =========================================================================

    /**
     * Assignment operator writes through to target
     */
    IEC_REFERENCE_TO& operator=(const T& value) {
        set(value);
        return *this;
    }

    /**
     * Implicit conversion to value type for reading
     */
    operator T() const { return get(); }

    // Arithmetic compound assignment operators (write through to target)
    IEC_REFERENCE_TO& operator+=(const T& v) {
        set(get() + v);
        return *this;
    }

    IEC_REFERENCE_TO& operator-=(const T& v) {
        set(get() - v);
        return *this;
    }

    IEC_REFERENCE_TO& operator*=(const T& v) {
        set(get() * v);
        return *this;
    }

    IEC_REFERENCE_TO& operator/=(const T& v) {
        set(get() / v);
        return *this;
    }
};

// =============================================================================
// VAR_IN_OUT of a function block (bound by reference at each call)
// =============================================================================

/**
 * A function-block VAR_IN_OUT member: a non-owning reference to the caller's
 * variable, bound by every call that maps the parameter (IEC 61131-3 Ed. 3
 * 6.6.1.4, 6.6.3.4). The body reaches the variable as `(*X)`, so field,
 * subscript and bit access apply to the caller's object itself.
 *
 * Unbound until the first call that binds it (and again after `unbind()`);
 * reaching it unbound raises the NullReference fault, as an unbound
 * REFERENCE TO does.
 *
 * @tparam T The C++ type of the parameter (IECVar<T>, a STRUCT, an array,
 *           a function-block class, a raw alias, a pointer wrapper, ...)
 */
template<typename T>
class IEC_INOUT {
    T* ptr_ = nullptr;

public:
    using value_type = T;

    IEC_INOUT() noexcept = default;

    /** Refer to `target` until the next binding. */
    void bind(T& target) noexcept { ptr_ = &target; }

    /** Drop the binding (the target's lifetime ends with the call). */
    void unbind() noexcept { ptr_ = nullptr; }

    bool is_bound() const noexcept { return ptr_ != nullptr; }

    /** The bound variable; raises the NullReference fault when unbound. */
    T& operator*() const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException("VAR_IN_OUT");
#else
            iec_runtime_fault(IecFault::NullReference, "VAR_IN_OUT");
#endif
        }
        return *ptr_;
    }
};

// =============================================================================
// REF() Function - Get Reference to Variable
// =============================================================================

/**
 * REF() operator - Get reference to an IECVar
 * Returns a REF_TO that can be assigned to a reference variable.
 *
 * Usage:
 *   IEC_INT myVar;
 *   REF_TO<INT_t> myRef = REF(myVar);
 */
template<typename T>
inline IEC_REF_TO<T> REF(IECVar<T>& var) noexcept {
    return IEC_REF_TO<T>(&var);
}

/**
 * REF() for references (reference to reference)
 * Allows creating a reference to a REF_TO variable.
 *
 * Usage:
 *   REF_TO<INT_t> ref1;
 *   REF_TO<REF_TO<INT_t>> ref2 = REF(ref1);
 */
template<typename T>
inline IEC_REF_TO<IEC_REF_TO<T>> REF(IEC_REF_TO<T>& ref) noexcept {
    return IEC_REF_TO<IEC_REF_TO<T>>(&ref);
}

/**
 * REF() for a pointer variable: REF_TO POINTER TO T.
 */
template<typename T>
inline IEC_REF_TO<IEC_Ptr<T>> REF(IEC_Ptr<T>& ptr) noexcept {
    return IEC_REF_TO<IEC_Ptr<T>>(&ptr);
}

/**
 * REF() of a STRUCT or function block variable, which holds the value itself.
 */
template<typename T, typename std::enable_if<detail::stored_directly<T>::value, int>::type = 0>
inline IEC_REF_TO<T> REF(T& var) noexcept {
    return IEC_REF_TO<T>(&var);
}

/**
 * REF() of a STRING or WSTRING variable, which is an IECStringVar /
 * IECWStringVar rather than an IECVar.
 */
template<size_t N>
inline IEC_REF_TO<IECString<N>> REF(IECStringVar<N>& var) noexcept {
    return IEC_REF_TO<IECString<N>>(&var);
}

template<size_t N>
inline IEC_REF_TO<IECWString<N>> REF(IECWStringVar<N>& var) noexcept {
    return IEC_REF_TO<IECWString<N>>(&var);
}

/**
 * REF() of a variable of a named STRING / WSTRING type (`TYPE T : STRING(10)`),
 * which is declared as the string itself. IECStringVar is exactly its string.
 */
template<size_t N>
inline IEC_REF_TO<IECString<N>> REF(IECString<N>& var) noexcept {
    return IEC_REF_TO<IECString<N>>(reinterpret_cast<IECStringVar<N>*>(&var));
}

template<size_t N>
inline IEC_REF_TO<IECWString<N>> REF(IECWString<N>& var) noexcept {
    return IEC_REF_TO<IECWString<N>>(reinterpret_cast<IECWStringVar<N>*>(&var));
}

/**
 * REF() of an enumeration variable, which is an IEC_ENUM_Var.
 */
template<typename E>
inline IEC_REF_TO<E> REF(IEC_ENUM_Var<E>& var) noexcept {
    return IEC_REF_TO<E>(&var);
}

// Note: REF() for array elements and struct fields works automatically
// because they return IECVar<T>& from operator[] and member access.

// =============================================================================
// Type Aliases
// =============================================================================

/**
 * Convenience alias for REF_TO types
 * Usage: REF_TO<INT_t> myRef;
 */
template<typename T>
using REF_TO = IEC_REF_TO<T>;

/**
 * Convenience alias for REFERENCE_TO types
 * Usage: REFERENCE_TO<INT_t> myRef{target};
 */
template<typename T>
using REFERENCE_TO = IEC_REFERENCE_TO<T>;

/*
 * Example usage (generated code for REF_TO):
 *
 * ST Source:
 *   VAR
 *       V1, V2 : INT;
 *       rV : REF_TO INT;
 *   END_VAR
 *
 *   rV := REF(V2);
 *   rV^ := 12;
 *   V1 := rV^;
 *
 *   IF rV <> NULL THEN
 *       rV^ := 42;
 *   END_IF;
 *
 * Generated C++:
 *   IEC_INT V1, V2;
 *   REF_TO<INT_t> rV;
 *
 *   rV = REF(V2);
 *   rV.deref().set(12);
 *   V1 = rV.deref().get();
 *
 *   if (rV != IEC_NULL) {
 *       rV.deref().set(42);
 *   }
 */

/*
 * Example usage (generated code for REFERENCE_TO):
 *
 * ST Source:
 *   VAR
 *       target : INT := 10;
 *       ref : REFERENCE_TO INT := target;
 *   END_VAR
 *
 *   ref := 42;       // Implicit write
 *   x := ref;        // Implicit read
 *   ref REF= other;  // Rebind
 *
 * Generated C++:
 *   IEC_INT target{10};
 *   REFERENCE_TO<INT_t> ref{target};
 *
 *   ref.set(42);
 *   x = ref.get();
 *   ref.bind(other);
 */

/*
 * Example usage (reference to array element):
 *
 * ST Source:
 *   VAR
 *       arr : ARRAY[1..10] OF INT;
 *       elem_ref : REF_TO INT;
 *   END_VAR
 *
 *   elem_ref := REF(arr[5]);
 *   elem_ref^ := 100;
 *
 * Generated C++:
 *   Array1D<INT_t, 1, 10> arr;
 *   REF_TO<INT_t> elem_ref;
 *
 *   elem_ref = REF(arr[5]);  // arr[5] returns IECVar<INT_t>&
 *   elem_ref.deref().set(100);
 */

// =============================================================================
// Interface Variable (IEC 61131-3 Ed. 3 interface-typed variables)
// =============================================================================

/**
 * A variable of interface type: a non-owning, nullable reference to an
 * instance of a function block that implements interface I. NULL by default.
 *
 * Assignment takes an implementing instance (any class derived from I),
 * another interface variable of I or of an interface extending I, or NULL.
 * A call through a NULL interface raises the null-reference fault, as a
 * NULL REF_TO dereference does. Equality compares the referenced instance.
 *
 * @tparam I The interface class (abstract, generated from INTERFACE)
 */
template<typename I>
class IEC_ITF {
    I* ptr_;

    template<typename U>
    using if_derived = typename std::enable_if<std::is_base_of<I, U>::value, int>::type;

public:
    using interface_type = I;

    IEC_ITF() noexcept : ptr_(nullptr) {}
    IEC_ITF(std::nullptr_t) noexcept : ptr_(nullptr) {}
    IEC_ITF(const IEC_ITF&) = default;
    IEC_ITF& operator=(const IEC_ITF&) = default;

    /** Refer to an implementing instance (`itf := fb`). */
    template<typename U, if_derived<U> = 0>
    IEC_ITF(U& obj) noexcept : ptr_(&obj) {}

    /** Take the instance of a variable of an extending interface. */
    template<typename J, if_derived<J> = 0>
    IEC_ITF(const IEC_ITF<J>& other) noexcept : ptr_(other.get()) {}

    IEC_ITF& operator=(std::nullptr_t) noexcept {
        ptr_ = nullptr;
        return *this;
    }

    template<typename U, if_derived<U> = 0>
    IEC_ITF& operator=(U& obj) noexcept {
        ptr_ = &obj;
        return *this;
    }

    template<typename J, if_derived<J> = 0>
    IEC_ITF& operator=(const IEC_ITF<J>& other) noexcept {
        ptr_ = other.get();
        return *this;
    }

    I* get() const noexcept { return ptr_; }
    bool is_null() const noexcept { return ptr_ == nullptr; }

    /** The referenced instance; raises the null-reference fault when NULL. */
    I& deref() const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException("call through a NULL interface");
#else
            iec_runtime_fault(IecFault::NullReference, "call through a NULL interface");
#endif
        }
        return *ptr_;
    }

    /** Pass to a VAR_IN_OUT or interface return of type I. */
    operator I&() const { return deref(); }

    bool operator==(std::nullptr_t) const noexcept { return ptr_ == nullptr; }
    bool operator!=(std::nullptr_t) const noexcept { return ptr_ != nullptr; }
};

namespace detail {
/** Address of the whole instance behind an interface pointer, for equality. */
template<typename I>
inline const void* itf_identity(const I* p) noexcept {
    return dynamic_cast<const void*>(p);
}
}  // namespace detail

/** Equal when both refer to the same instance (or both are NULL). */
template<typename I, typename J>
inline bool operator==(const IEC_ITF<I>& a, const IEC_ITF<J>& b) noexcept {
    return detail::itf_identity(a.get()) == detail::itf_identity(b.get());
}

template<typename I, typename J>
inline bool operator!=(const IEC_ITF<I>& a, const IEC_ITF<J>& b) noexcept {
    return !(a == b);
}

template<typename I>
inline bool operator==(std::nullptr_t, const IEC_ITF<I>& b) noexcept { return b.is_null(); }
template<typename I>
inline bool operator!=(std::nullptr_t, const IEC_ITF<I>& b) noexcept { return !b.is_null(); }

/**
 * The instance a method is called on: an interface variable is dereferenced
 * (NULL raises the fault), anything else (a VAR_IN_OUT `I&`) passes through.
 */
template<typename I>
inline I& itf_ref(IEC_ITF<I>& p) { return p.deref(); }
template<typename I>
inline I& itf_ref(const IEC_ITF<I>& p) { return p.deref(); }
template<typename T>
inline T& itf_ref(T& obj) noexcept { return obj; }

/**
 * The binding a REFERENCE TO input receives at a call: a reference to the
 * argument variable, or the argument's own binding when it is a reference.
 */
template<typename T>
inline IEC_REFERENCE_TO<T> ref_bind(IECVar<T>& var) noexcept {
    return IEC_REFERENCE_TO<T>(var);
}
template<typename T>
inline IEC_REFERENCE_TO<T> ref_bind(const IEC_REFERENCE_TO<T>& ref) noexcept {
    return ref;
}
template<size_t N>
inline IEC_REFERENCE_TO<IECString<N>> ref_bind(IECStringVar<N>& var) noexcept {
    return IEC_REFERENCE_TO<IECString<N>>(var);
}
template<size_t N>
inline IEC_REFERENCE_TO<IECWString<N>> ref_bind(IECWStringVar<N>& var) noexcept {
    return IEC_REFERENCE_TO<IECWString<N>>(var);
}

}  // namespace strucpp
