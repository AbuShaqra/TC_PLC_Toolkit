// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2026 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
//
// KEEP THIS HEADER C++14-CLEAN (see iec_var.hpp): no inline variables, no
// `if constexpr`, no C++17 library headers. <mutex> / <atomic> are pulled in
// only under STRUCPP_THREADED.
/**
 * STruC++ Runtime - Force table
 *
 * Forcing pins a variable to a value chosen from outside the program (the
 * debugger, the REPL). The value is kept here, beside the variable, not in it:
 * a variable is only its own bytes, so memory is laid out as on a PLC.
 *
 * A forced value is written into its variable
 *   - at once, when the force is set (so a stopped program shows it), and
 *   - at both cycle boundaries, by a `force::Scope` held around a program's
 *     cycle: at cycle start (after the host's input copy-in) and at cycle end
 *     (before the host's output copy-out, also on an early RETURN or a fault).
 * Between the two, a program that writes a forced variable sees its own write
 * until the cycle ends, as with typical PLC forcing.
 *
 * Storage is two fixed pools, no allocation:
 *   - STRUCPP_FORCE_SLOTS scalar slots of SCALAR_BYTES bytes each;
 *   - STRUCPP_FORCE_STRING_SLOTS slots of STRUCPP_FORCE_STRING_BYTES bytes,
 *     for a value larger than a scalar (STRING / WSTRING).
 * A force past the bound is refused with Status::Full, never dropped silently.
 *
 * Threads (STRUCPP_THREADED): one mutex guards the table. The scan takes it
 * only to apply, and only while the table is non-empty; the empty check is one
 * relaxed atomic load. A Scope then applies the slots inside its own program
 * instance plus the slots marked FLAG_GLOBAL, so a task never writes another
 * task's variables. set() writes the variable once from the caller's thread,
 * as forcing always has.
 */

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#ifdef STRUCPP_THREADED
#include <atomic>
#include <mutex>
#endif

/** Number of scalar force slots. */
#ifndef STRUCPP_FORCE_SLOTS
#ifdef __AVR__
#define STRUCPP_FORCE_SLOTS 16
#else
#define STRUCPP_FORCE_SLOTS 64
#endif
#endif

/** Number of force slots for values larger than a scalar (STRING / WSTRING). */
#ifndef STRUCPP_FORCE_STRING_SLOTS
#ifdef __AVR__
#define STRUCPP_FORCE_STRING_SLOTS 1
#else
#define STRUCPP_FORCE_STRING_SLOTS 8
#endif
#endif

/** Bytes a string force slot holds: the characters and their terminator. */
#ifndef STRUCPP_FORCE_STRING_BYTES
#ifdef __AVR__
#define STRUCPP_FORCE_STRING_BYTES 127
#else
#define STRUCPP_FORCE_STRING_BYTES 256
#endif
#endif

namespace strucpp {
namespace force {

/** Largest value a scalar slot holds (LWORD / LREAL / LTIME). */
constexpr uint16_t SCALAR_BYTES = 8;

/** Slot flag: the variable belongs to no program instance (a global). */
constexpr uint8_t FLAG_GLOBAL = 1 << 0;

/** Result of set(). */
enum class Status : uint8_t {
    Ok = 0,
    /** Every slot of the pool the value needs is taken. */
    Full,
    /** The value is larger than a slot of any pool. */
    TooLarge,
    /** A null variable or a zero-length value. */
    BadArgument,
};

/**
 * Writes a forced value into its variable. Null means a plain copy of `size`
 * bytes; a type whose stored form is not its value bytes supplies its own.
 */
using ApplyFn = void (*)(void* dst, const uint8_t* bytes, uint16_t size);

namespace detail {

template <std::size_t N>
struct Slot {
    void* ptr;
    ApplyFn apply;
    uint16_t size;
    uint8_t flags;
    bool used;
    uint8_t bytes[N];
};

using ScalarSlot = Slot<SCALAR_BYTES>;
using StringSlot = Slot<STRUCPP_FORCE_STRING_BYTES>;

/** Members are left without initializers: a static Table is zero-initialised,
 *  and the non-threaded table stays trivial (no guard, no constructor). */
struct Table {
    ScalarSlot scalars[STRUCPP_FORCE_SLOTS];
    StringSlot strings[STRUCPP_FORCE_STRING_SLOTS];
#ifdef STRUCPP_THREADED
    std::atomic<uint16_t> count;
    std::mutex mtx;
#else
    uint16_t count;
#endif
};

/** The process-wide table (one instance across translation units). */
inline Table& table() noexcept {
    static Table t;
    return t;
}

inline uint16_t load_count(const Table& t) noexcept {
#ifdef STRUCPP_THREADED
    return t.count.load(std::memory_order_relaxed);
#else
    return t.count;
#endif
}

inline void add_count(Table& t, int delta) noexcept {
#ifdef STRUCPP_THREADED
    t.count.store(static_cast<uint16_t>(t.count.load(std::memory_order_relaxed) + delta),
                  std::memory_order_relaxed);
#else
    t.count = static_cast<uint16_t>(t.count + delta);
#endif
}

/** Holds the table lock for a scope; a no-op without STRUCPP_THREADED. */
class Lock {
public:
#ifdef STRUCPP_THREADED
    explicit Lock(Table& t) : guard_(t.mtx) {}
private:
    std::lock_guard<std::mutex> guard_;
#else
    explicit Lock(Table&) noexcept {}
#endif
};

template <std::size_t N>
inline void apply_slot(const Slot<N>& s) noexcept {
    if (s.apply != nullptr) {
        s.apply(s.ptr, s.bytes, s.size);
    } else {
        std::memcpy(s.ptr, s.bytes, s.size);
    }
}

template <std::size_t N, std::size_t M>
inline Slot<N>* find_in(Slot<N> (&pool)[M], const void* ptr) noexcept {
    for (std::size_t i = 0; i < M; ++i) {
        if (pool[i].used && pool[i].ptr == ptr) return &pool[i];
    }
    return nullptr;
}

template <std::size_t N, std::size_t M>
inline Slot<N>* free_in(Slot<N> (&pool)[M]) noexcept {
    for (std::size_t i = 0; i < M; ++i) {
        if (!pool[i].used) return &pool[i];
    }
    return nullptr;
}

template <std::size_t N>
inline void fill(Slot<N>& s, void* ptr, const void* bytes, uint16_t size,
                 uint8_t flags, ApplyFn apply) noexcept {
    s.ptr = ptr;
    s.apply = apply;
    s.size = size;
    s.flags = flags;
    s.used = true;
    std::memcpy(s.bytes, bytes, size);
}

/** Puts a force into pool `into`, dropping any slot the variable holds in pool `other`. */
template <std::size_t N, std::size_t M, std::size_t N2, std::size_t M2>
inline Status put(Table& t, Slot<N> (&into)[M], Slot<N2> (&other)[M2], void* ptr,
                  const void* bytes, uint16_t size, uint8_t flags, ApplyFn apply) noexcept {
    Slot<N>* s = find_in(into, ptr);
    if (s == nullptr) {
        s = free_in(into);
        if (s == nullptr) return Status::Full;
        Slot<N2>* old = find_in(other, ptr);
        if (old != nullptr) {
            old->used = false;
        } else {
            add_count(t, 1);
        }
    }
    fill(*s, ptr, bytes, size, flags, apply);
    apply_slot(*s);
    return Status::Ok;
}

inline bool owned(const void* ptr, uint8_t flags, std::uintptr_t lo, std::uintptr_t hi) noexcept {
    const std::uintptr_t p = reinterpret_cast<std::uintptr_t>(ptr);
    return (flags & FLAG_GLOBAL) != 0 || (p >= lo && p < hi);
}

}  // namespace detail

namespace detail {

/** set() with the table lock already held. */
inline Status set_locked(Table& t, void* ptr, const void* bytes, uint16_t size,
                         uint8_t flags, ApplyFn apply) noexcept {
    if (ptr == nullptr || bytes == nullptr || size == 0) return Status::BadArgument;
    if (size > STRUCPP_FORCE_STRING_BYTES) return Status::TooLarge;
    if (size <= SCALAR_BYTES) {
        return put(t, t.scalars, t.strings, ptr, bytes, size, flags, apply);
    }
    return put(t, t.strings, t.scalars, ptr, bytes, size, flags, apply);
}

/** clear() with the table lock already held. */
inline bool clear_locked(Table& t, const void* ptr) noexcept {
    ScalarSlot* s = find_in(t.scalars, ptr);
    if (s != nullptr) {
        s->used = false;
        add_count(t, -1);
        return true;
    }
    StringSlot* w = find_in(t.strings, ptr);
    if (w != nullptr) {
        w->used = false;
        add_count(t, -1);
        return true;
    }
    return false;
}

}  // namespace detail

/**
 * Force the variable at `ptr` to the `size` bytes at `bytes` and write them
 * into it now. Forcing a forced variable again replaces its value.
 */
inline Status set(void* ptr, const void* bytes, uint16_t size, uint8_t flags = 0,
                  ApplyFn apply = nullptr) noexcept {
    detail::Table& t = detail::table();
    detail::Lock lock(t);
    return detail::set_locked(t, ptr, bytes, size, flags, apply);
}

/** Stop forcing the variable at `ptr`; it keeps its current value. False if it was not forced. */
inline bool clear(const void* ptr) noexcept {
    detail::Table& t = detail::table();
    detail::Lock lock(t);
    return detail::clear_locked(t, ptr);
}

/** Stop every force. */
inline void clear_all() noexcept {
    detail::Table& t = detail::table();
    detail::Lock lock(t);
    for (auto& s : t.scalars) s.used = false;
    for (auto& s : t.strings) s.used = false;
    detail::add_count(t, -static_cast<int>(detail::load_count(t)));
}

/** Number of forced variables. */
inline uint16_t count() noexcept {
    return detail::load_count(detail::table());
}

/** True while the variable at `ptr` is forced. */
inline bool is_forced(const void* ptr) noexcept {
    detail::Table& t = detail::table();
    if (detail::load_count(t) == 0) return false;
    detail::Lock lock(t);
    return detail::find_in(t.scalars, ptr) != nullptr || detail::find_in(t.strings, ptr) != nullptr;
}

/**
 * Copy the forced value of the variable at `ptr` into `dest` (at most `cap`
 * bytes). Returns the value's size, or 0 when the variable is not forced or
 * the value does not fit.
 */
inline uint16_t read(const void* ptr, void* dest, uint16_t cap) noexcept {
    detail::Table& t = detail::table();
    if (detail::load_count(t) == 0) return 0;
    detail::Lock lock(t);
    const detail::ScalarSlot* s = detail::find_in(t.scalars, ptr);
    if (s != nullptr) {
        if (s->size > cap) return 0;
        std::memcpy(dest, s->bytes, s->size);
        return s->size;
    }
    const detail::StringSlot* w = detail::find_in(t.strings, ptr);
    if (w != nullptr) {
        if (w->size > cap) return 0;
        std::memcpy(dest, w->bytes, w->size);
        return w->size;
    }
    return 0;
}

/**
 * Address of the forced value of the variable at `ptr` (its size in `*size`),
 * or nullptr when it is not forced. Valid until the force is changed or
 * cleared, so only for a caller on the scan's own thread.
 */
inline const void* value_ptr(const void* ptr, uint16_t* size) noexcept {
    detail::Table& t = detail::table();
    if (detail::load_count(t) != 0) {
        detail::Lock lock(t);
        const detail::ScalarSlot* s = detail::find_in(t.scalars, ptr);
        if (s != nullptr) {
            *size = s->size;
            return s->bytes;
        }
        const detail::StringSlot* w = detail::find_in(t.strings, ptr);
        if (w != nullptr) {
            *size = w->size;
            return w->bytes;
        }
    }
    *size = 0;
    return nullptr;
}

/** Write every forced value into its variable. */
inline void apply_all() noexcept {
    detail::Table& t = detail::table();
    if (detail::load_count(t) == 0) return;
    detail::Lock lock(t);
    for (const auto& s : t.scalars) {
        if (s.used) detail::apply_slot(s);
    }
    for (const auto& s : t.strings) {
        if (s.used) detail::apply_slot(s);
    }
}

/**
 * Write the forced values of the variables inside `[base, base + len)` and of
 * every FLAG_GLOBAL variable.
 */
inline void apply_owned(const void* base, std::size_t len) noexcept {
    detail::Table& t = detail::table();
    if (detail::load_count(t) == 0) return;
    const std::uintptr_t lo = reinterpret_cast<std::uintptr_t>(base);
    const std::uintptr_t hi = lo + len;
    detail::Lock lock(t);
    for (const auto& s : t.scalars) {
        if (s.used && detail::owned(s.ptr, s.flags, lo, hi)) detail::apply_slot(s);
    }
    for (const auto& s : t.strings) {
        if (s.used && detail::owned(s.ptr, s.flags, lo, hi)) detail::apply_slot(s);
    }
}

/**
 * Held around one cycle of a program instance: applies the forced values when
 * the cycle starts and again when it ends. Without STRUCPP_THREADED every
 * force is applied; with it, only those the instance owns and the globals.
 */
class Scope {
public:
    Scope(const void* self, std::size_t len) noexcept : self_(self), len_(len) { apply(); }
    ~Scope() { apply(); }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;

private:
    void apply() const noexcept { apply_scope(self_, len_); }

    static void apply_scope(const void* self, std::size_t len) noexcept {
#ifdef STRUCPP_THREADED
        apply_owned(self, len);
#else
        (void)self;
        (void)len;
        apply_all();
#endif
    }
    const void* self_;
    std::size_t len_;
};

}  // namespace force
}  // namespace strucpp

// ---------------------------------------------------------------------------
// Entry points for a source-level debugger that has stopped the program and
// evaluates a call in it (the VS Code extension's Force Variable command).
// `used` keeps them in every translation unit that includes this header, so
// the debugger can find them although nothing in the program calls them.
//
// They never wait for the table lock: a thread stopped while applying holds
// it, and waiting would hang the debugger. They report 5 instead.
// ---------------------------------------------------------------------------
#if defined(__GNUC__) && !defined(__AVR__)
#define STRUCPP_DEBUGGER_ENTRY extern "C" __attribute__((used, noinline)) inline

namespace strucpp {
namespace force {
namespace detail {

/** Status code the debugger entry points return while the table is locked. */
constexpr int DEBUGGER_TABLE_BUSY = 5;

template <typename F>
inline int with_table_try_lock(F&& f) noexcept {
    Table& t = table();
#ifdef STRUCPP_THREADED
    if (!t.mtx.try_lock()) return DEBUGGER_TABLE_BUSY;
    const int result = f(t);
    t.mtx.unlock();
    return result;
#else
    return f(t);
#endif
}

}  // namespace detail
}  // namespace force
}  // namespace strucpp

/** Force the variable at `ptr` to the `size` bytes it holds now. 0 when forced,
 *  otherwise a force::Status value or 5 (table busy). */
STRUCPP_DEBUGGER_ENTRY int strucpp_force_capture(void* ptr, unsigned size) noexcept {
    return strucpp::force::detail::with_table_try_lock([&](strucpp::force::detail::Table& t) {
        uint8_t value[STRUCPP_FORCE_STRING_BYTES];
        if (ptr == nullptr || size == 0 || size > sizeof value) {
            return static_cast<int>(size > sizeof value ? strucpp::force::Status::TooLarge
                                                        : strucpp::force::Status::BadArgument);
        }
        std::memcpy(value, ptr, size);
        return static_cast<int>(strucpp::force::detail::set_locked(
            t, ptr, value, static_cast<uint16_t>(size), 0, nullptr));
    });
}

/** Stop forcing the variable at `ptr`. 0 when it was forced, 1 when it was
 *  not, 5 when the table is busy. */
STRUCPP_DEBUGGER_ENTRY int strucpp_unforce(void* ptr) noexcept {
    return strucpp::force::detail::with_table_try_lock([&](strucpp::force::detail::Table& t) {
        return strucpp::force::detail::clear_locked(t, ptr) ? 0 : 1;
    });
}

#undef STRUCPP_DEBUGGER_ENTRY
#endif
