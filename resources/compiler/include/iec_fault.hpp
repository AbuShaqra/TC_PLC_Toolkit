// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2026 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * iec_fault.hpp — unrecoverable-fault handling for the STruC++ runtime.
 *
 * STruC++ runs on two very different classes of target:
 *
 *   - Hosted (Linux/Windows OpenPLC runtime, the REPL, the test harness):
 *     compiled WITH C++ exceptions. Runtime faults `throw`, and the host
 *     catches them — e.g. to stop the offending POU while the rest of the
 *     program keeps scanning, or to print a diagnostic and exit cleanly.
 *
 *   - Freestanding (microcontroller firmware: AVR, SAMD, RP2040, STM32, …):
 *     compiled with `-fno-exceptions`. There is nothing to catch a throw and
 *     the C++ exception runtime is dead weight (~10-15 KB of unwinder), so
 *     instead of throwing, the runtime calls `iec_runtime_fault()`.
 *
 * The selection is keyed off whether the *compiler* has exceptions enabled
 * (`STRUCPP_HAS_EXCEPTIONS`), NOT off any particular chip macro — so every
 * `-fno-exceptions` target uniformly takes the fault path with no per-board
 * flags.
 */
#pragma once

#include <cstdint>
#include <type_traits>
#include <utility>

// Are C++ exceptions available in this translation unit? GCC/Clang define
// __cpp_exceptions / __EXCEPTIONS with -fexceptions (the hosted default) and
// leave them undefined with -fno-exceptions; MSVC uses _CPPUNWIND.
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#  define STRUCPP_HAS_EXCEPTIONS 1
#else
#  define STRUCPP_HAS_EXCEPTIONS 0
#endif

#if STRUCPP_HAS_EXCEPTIONS
#include <stdexcept>
#endif

#if defined(__GNUC__)
#  define STRUCPP_FAULT_PATH __attribute__((noinline, cold))
#else
#  define STRUCPP_FAULT_PATH
#endif

namespace strucpp {

/**
 * Reason an unrecoverable runtime fault was raised. Passed to
 * `iec_runtime_fault()` so a platform hook can react per-cause (distinct LED
 * blink code, alarm tone, log line, …).
 */
enum class IecFault : uint8_t {
    NullReference = 0,  ///< Dereferenced a NULL IEC pointer/reference.
    ArrayBounds   = 1,  ///< IEC array index out of bounds.
    BadLocation   = 2,  ///< Invalid located-variable area/size character.
    DivideByZero  = 3,  ///< Integer division by zero.
    Subrange      = 4,  ///< A value stored outside its subrange.
};

/** Where a fault happened: the POU and the line of its source, as compiled. */
struct iec_site {
    const char* pou;
    int line;
};

/**
 * The task running on this thread, named in a fault; nullptr outside a task.
 * A runtime that dispatches tasks sets it with strucpp_set_current_task().
 */
#ifdef STRUCPP_THREADED
inline const char*& iec_current_task_slot() noexcept {
    static thread_local const char* task = nullptr;
    return task;
}
#else
inline const char*& iec_current_task_slot() noexcept {
    static const char* task = nullptr;
    return task;
}
#endif

/** Name the task now running on this thread (nullptr: none). */
inline void strucpp_set_current_task(const char* name) noexcept {
    iec_current_task_slot() = name;
}

/**
 * Unrecoverable-fault handler for targets compiled WITHOUT exceptions — the
 * freestanding analogue of `throw`. It MUST NOT return.
 *
 * Only *declared* here. A weak default definition (provided by the firmware
 * glue) halts the CPU; a platform/VPP HAL may supply a strong definition to
 * blink a fault LED keyed off `reason`, sound an alarm, reboot, etc.
 *
 * On hosted (exception) builds this is never referenced — those code paths
 * `throw` instead — so no definition is required there.
 *
 * @param reason  what went wrong (for platform-specific signalling)
 * @param context optional human-readable context; may be nullptr
 */
[[noreturn]] void iec_runtime_fault(IecFault reason, const char* context = nullptr) noexcept;

#if STRUCPP_HAS_EXCEPTIONS
/** A run-time fault at a known site: what happened, the POU, line and task. */
class IecSiteFault : public std::runtime_error {
public:
    IecSiteFault(IecFault reason, const char* message)
        : std::runtime_error(message), reason_(reason) {}
    IecFault reason() const noexcept { return reason_; }
private:
    IecFault reason_;
};
#endif

namespace detail {

/** A fault message in a fixed buffer: no allocation, so a target without exceptions builds it too. */
class fault_text {
public:
    fault_text() noexcept { buf_[0] = '\0'; }
    fault_text& add(const char* s) noexcept {
        while (s != nullptr && *s != '\0' && len_ + 1 < sizeof(buf_)) buf_[len_++] = *s++;
        buf_[len_] = '\0';
        return *this;
    }
    fault_text& add_unsigned(unsigned long long v) noexcept {
        char digits[24];
        unsigned n = 0;
        do {
            digits[n++] = static_cast<char>('0' + v % 10);
            v /= 10;
        } while (v != 0);
        while (n > 0 && len_ + 1 < sizeof(buf_)) buf_[len_++] = digits[--n];
        buf_[len_] = '\0';
        return *this;
    }
    fault_text& add_signed(long long v) noexcept {
        if (v >= 0) return add_unsigned(static_cast<unsigned long long>(v));
        add("-");
        return add_unsigned(0ULL - static_cast<unsigned long long>(v));
    }
    /** An integer value as written, unsigned ones above 2^63 included. */
    template<typename T>
    fault_text& add_number(T v) noexcept {
        return v < static_cast<T>(0) ? add_signed(static_cast<long long>(v))
                                     : add_unsigned(static_cast<unsigned long long>(v));
    }
    /**
     * Append " in <pou>", `line` (", line <n>") and ", task <task>" (none when
     * `task` is null). The description and the line are kept whole: a message
     * too long is shortened in the POU name first, then in the task name, each
     * marked with "…", and only then in the description. A cut never splits a
     * UTF-8 character.
     */
    void finish(const char* pou, const fault_text& line, const char* task) noexcept {
        static const char ellipsis[] = "\xE2\x80\xA6";
        const unsigned mark = sizeof(ellipsis) - 1;
        const unsigned cap = sizeof(buf_) - 1;
        const unsigned pl = length(pou);
        const unsigned tl = task != nullptr ? length(task) : 0;
        unsigned pou_keep = pl;
        unsigned task_keep = tl;
        bool pou_cut = false;
        bool task_cut = false;
        auto total = [&]() -> unsigned {
            return len_ + 4 + pou_keep + (pou_cut ? mark : 0) + line.len_ +
                   (task != nullptr ? 7 + task_keep + (task_cut ? mark : 0) : 0);
        };
        if (total() > cap) {
            pou_cut = true;
            const unsigned over = total() - cap;
            pou_keep = over >= pl ? 0 : utf8_prefix(pou, pl - over);
        }
        if (total() > cap && task != nullptr) {
            task_cut = true;
            const unsigned over = total() - cap;
            task_keep = over >= tl ? 0 : utf8_prefix(task, tl - over);
        }
        if (total() > cap) {
            const unsigned over = total() - cap + mark;
            len_ = over >= len_ ? 0 : utf8_prefix(buf_, len_ - over);
            buf_[len_] = '\0';
            add(ellipsis);
        }
        add(" in ").add_prefix(pou, pou_keep);
        if (pou_cut) add(ellipsis);
        add(line.c_str());
        if (task != nullptr) {
            add(", task ").add_prefix(task, task_keep);
            if (task_cut) add(ellipsis);
        }
    }
    const char* c_str() const noexcept { return buf_; }
    bool empty() const noexcept { return len_ == 0; }
    char back() const noexcept { return len_ == 0 ? '\0' : buf_[len_ - 1]; }
private:
    static unsigned length(const char* s) noexcept {
        unsigned n = 0;
        while (s[n] != '\0') ++n;
        return n;
    }
    /** `n`, or less so that the first `n` bytes of `s` end on a whole UTF-8 character. */
    static unsigned utf8_prefix(const char* s, unsigned n) noexcept {
        while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0u) == 0x80u) --n;
        return n;
    }
    fault_text& add_prefix(const char* s, unsigned n) noexcept {
        for (unsigned i = 0; i < n && len_ + 1 < sizeof(buf_); ++i) buf_[len_++] = s[i];
        buf_[len_] = '\0';
        return *this;
    }
    char buf_[224];
    unsigned len_ = 0;
};

}  // namespace detail

/**
 * Raise `reason`: `text` (what happened), then " in <POU>, line <n>, task <T>".
 * A hosted target throws IecSiteFault; one without exceptions passes the same
 * text to iec_runtime_fault().
 */
[[noreturn]] STRUCPP_FAULT_PATH inline void iec_raise_fault(
    IecFault reason, detail::fault_text& text, iec_site site) {
    detail::fault_text line;
    line.add(", line ").add_signed(site.line);
    text.finish(site.pou != nullptr ? site.pou : "?", line, iec_current_task_slot());
#if STRUCPP_HAS_EXCEPTIONS
    throw IecSiteFault(reason, text.c_str());
#else
    iec_runtime_fault(reason, text.c_str());
#endif
}

/** Raise `reason` at `site`, with `what` describing it ("Division by zero"). */
[[noreturn]] STRUCPP_FAULT_PATH inline void iec_site_fault(
    IecFault reason, const char* what, iec_site site) {
    detail::fault_text text;
    text.add(what);
    iec_raise_fault(reason, text, site);
}

namespace detail {

/** The site of the array access in progress, for a target without exceptions (iec_at sets it). */
#ifdef STRUCPP_THREADED
inline const iec_site*& bounds_site() noexcept {
    static thread_local const iec_site* site = nullptr;
    return site;
}
#else
inline const iec_site*& bounds_site() noexcept {
    static const iec_site* site = nullptr;
    return site;
}
#endif

/**
 * An index outside an array's bounds: `std::out_of_range`, to which iec_at
 * adds the site; without exceptions, the fault at the site iec_at noted.
 */
[[noreturn]] STRUCPP_FAULT_PATH inline void bounds_fault(
    const char* what = "Array index out of bounds") {
#if STRUCPP_HAS_EXCEPTIONS
    throw std::out_of_range(what);
#else
    fault_text text;
    text.add(what);
    if (bounds_site() == nullptr) iec_runtime_fault(IecFault::ArrayBounds, text.c_str());
    iec_raise_fault(IecFault::ArrayBounds, text, *bounds_site());
#endif
}

inline void add_indices(fault_text&) {}
template<typename I, typename... Rest>
inline void add_indices(fault_text& text, const I& first, const Rest&... rest) {
    if (!text.empty() && text.back() != '[' && text.back() != ' ') text.add(", ");
    text.add_number(+first);
    add_indices(text, rest...);
}

/** An index no array has: an unsigned one beyond the signed 64-bit range array bounds use. */
template<typename I>
constexpr bool beyond_int64(const I& index) noexcept {
    return static_cast<decltype(+index)>(-1) > static_cast<decltype(+index)>(0) &&
           static_cast<unsigned long long>(+index) > 9223372036854775807ULL;
}
inline constexpr bool any_beyond_int64() noexcept { return false; }
template<typename I, typename... Rest>
constexpr bool any_beyond_int64(const I& first, const Rest&... rest) noexcept {
    return beyond_int64(first) || any_beyond_int64(rest...);
}

/** Raise the index fault: `what`, the indices as written, the site. */
template<typename... I>
[[noreturn]] STRUCPP_FAULT_PATH void index_fault(const char* what, iec_site site, const I&... idx) {
    fault_text text;
    text.add(what).add(sizeof...(I) > 1 ? ": [" : ": ");
    add_indices(text, idx...);
    if (sizeof...(I) > 1) text.add("]");
    iec_raise_fault(IecFault::ArrayBounds, text, site);
}

/** The text of a NULL dereference of a `P`; REF_TO specialises it. */
template<typename P>
struct null_deref {
    static constexpr const char* text = "Null pointer dereference";
};

}  // namespace detail

/**
 * `c.at(i...)` at a known site: an index out of bounds is a fault naming the
 * indices (as written), the POU, the line and the task. Without exceptions the
 * site is named, not the index. Built with STRUCPP_NO_BOUNDS_CHECK, no check.
 */
template<typename C, typename... I>
inline decltype(auto) iec_at(C&& c, iec_site site, I... idx) {
#ifndef STRUCPP_NO_BOUNDS_CHECK
    if (detail::any_beyond_int64(idx...)) {
        detail::index_fault("Array index out of bounds", site, idx...);
    }
#endif
#if STRUCPP_HAS_EXCEPTIONS
    try {
        return c.at(idx...);
    } catch (const std::out_of_range& e) {
        detail::index_fault(e.what(), site, idx...);
    }
#else
    detail::bounds_site() = &site;
    decltype(auto) element = c.at(idx...);
    detail::bounds_site() = nullptr;
    return element;
#endif
}

/**
 * `p`, checked at a known site before `*` dereferences it: a NULL POINTER TO
 * or REF_TO is a fault naming the POU, line and task. It returns the pointer,
 * not `*p`, so the target type keeps its attributes (a may_alias target).
 */
template<typename P>
inline P&& iec_deref(P&& p, iec_site site) {
#ifndef STRUCPP_NO_BOUNDS_CHECK
    if (!p) {
        detail::fault_text text;
        text.add(detail::null_deref<std::decay_t<P>>::text);
        iec_raise_fault(IecFault::NullReference, text, site);
    }
#else
    (void)site;
#endif
    return std::forward<P>(p);
}

/** The object a REFERENCE TO is bound to; an unbound one is a fault naming the reference and the site. */
template<typename R>
inline auto iec_ref(R& r, const char* name, iec_site site) -> decltype(r.target()) {
#ifndef STRUCPP_NO_BOUNDS_CHECK
    if (r.is_null()) {
        detail::fault_text text;
        text.add("Unbound REFERENCE TO ").add(name);
        iec_raise_fault(IecFault::NullReference, text, site);
    }
#else
    (void)name; (void)site;
#endif
    return r.target();
}

/** An Ed. 3 `s[i]` outside the string's current length (1..LEN). */
[[noreturn]] inline void iec_string_index_fault() {
#if STRUCPP_HAS_EXCEPTIONS
    throw std::out_of_range("String index out of bounds");
#else
    detail::bounds_fault("String index out of bounds");
#endif
}

}  // namespace strucpp
