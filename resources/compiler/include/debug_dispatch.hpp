// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2025 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - Debugger Dispatch
 *
 * Per-entry force/unforce/read operations for the OpenPLC debugger protocol.
 *
 * Each leaf variable in a compiled project (including array elements, struct
 * fields, and FB internals) is registered in a compile-time Entry table with
 * {void* ptr, uint8_t tag}. The pointer is to the leaf's own IECVar<T>; the
 * tag indexes this file's type_ops table, which holds templated function
 * pointers that know how to force/unforce/read that concrete T.
 *
 * The table itself is emitted per-project by STruC++ into generated_debug.cpp.
 * This header provides the shared, project-agnostic dispatch logic.
 */

#pragma once

// `debug_table.hpp` is the AVR-clean header generated_debug.cpp also
// includes — it carries the Entry / TypeTag / STRUCPP_DEBUG_FLASH bits
// shared between the table emitter and the dispatch helpers.  Importing
// it here (rather than redefining) keeps the ABI definitions in exactly
// one place.  See debug_table.hpp's preamble for why
// `<avr/pgmspace.h>` no longer lives in the same TU as user variable
// references.
#include "debug_table.hpp"

#include "iec_types.hpp"
#include "iec_traits.hpp"
#include "iec_var.hpp"
#include "iec_string.hpp"
#include "iec_wstring.hpp"
#include "iec_force.hpp"
#include <algorithm>
#include <cstdint>
#include <cstddef>
#include <cstring>

#ifdef __AVR__
// `read_entry` and friends use `pgm_read_word_far` / `pgm_read_byte` /
// `pgm_get_far_address`, which live here.  Only the runtime translation
// unit (arduino_runtime_glue.cpp / runtime_v4_entry.cpp) ever needs
// this dispatch header; `generated_debug.cpp` consumes only
// `debug_table.hpp` so it never sees the AVR register-macro contamination
// `<avr/io.h>` brings in transitively.
#include <avr/pgmspace.h>
#endif

namespace strucpp { namespace debug {

// ---------------------------------------------------------------------------
// Status codes used by the protocol helpers below.
// Match the values the MatIEC-era ModbusSlave expected (0x7E / 0x81 / 0x82)
// so wire-format parsers on the editor don't need to change.
// ---------------------------------------------------------------------------
constexpr uint8_t STATUS_OK              = 0x7E;
constexpr uint8_t STATUS_OUT_OF_BOUNDS   = 0x81;
constexpr uint8_t STATUS_DATA_TOO_LARGE  = 0x82;
// 0x83..0x85 are taken by the licensing FCs (MB_DEBUG_LIC_*), and 0x86 by
// PLC_SET_STATE's REFUSED_BY_SWITCH (see the editor's ModbusDebugResponse
// enum) — this is the next actually-free code. Returned when a write or
// force targets a leaf carrying LEAF_FLAG_READONLY — an IEC CONSTANT. The
// refusal lives HERE, at the bottom of the stack, so it holds for every
// caller: the editor's debugger, an OPC-UA client, a plugin, or an older
// editor build that never learned to hide the control.
constexpr uint8_t STATUS_READ_ONLY       = 0x87;
// Returned when a force is refused because every force-table slot it would
// need is taken (iec_force.hpp: STRUCPP_FORCE_SLOTS / _STRING_SLOTS). The
// leaf is left as it was; unforcing another leaf frees a slot.
constexpr uint8_t STATUS_FORCE_TABLE_FULL = 0x88;
// Returned when a STRING write or force carries a payload that is not
// well-formed UTF-8, holds a character Windows-1252 lacks (a STRING stores one
// CP1252 byte per character), or holds a NUL: a STRING ends at its first NUL,
// so the stored value would be cut there. The leaf is left as it was.
constexpr uint8_t STATUS_NOT_ENCODABLE   = 0x89;

// ---------------------------------------------------------------------------
// Templated per-type helpers. One instantiation per IEC elementary type;
// type_ops[] below wires them into a runtime-indexable table.
//
// Forcing goes through the force table (iec_force.hpp), not the variable: a
// force records the value beside the leaf, writes it in at once, and every
// PROGRAM cycle writes it in again at its start and its end. Reads and soft
// writes consult the table so an external client sees the forced value and
// cannot move a forced leaf, whatever the program did inside the cycle.
// ---------------------------------------------------------------------------

/** Map a force::set() refusal onto the protocol's status codes. */
inline uint8_t force_status(force::Status s) noexcept {
    switch (s) {
        case force::Status::Ok:       return STATUS_OK;
        case force::Status::Full:     return STATUS_FORCE_TABLE_FULL;
        default:                      return STATUS_DATA_TOO_LARGE;
    }
}

template <typename T>
inline T decode_scalar(const uint8_t* bytes) noexcept {
    T v;
    std::memcpy(&v, bytes, sizeof(T));
    return v;
}

// memcpy-into-bool is technically UB for non-{0,1} byte values, and some AVR
// GCC versions have optimizer behavior around bool that can surprise.
// Normalize explicitly.
template <>
inline bool decode_scalar<bool>(const uint8_t* bytes) noexcept {
    return bytes[0] != 0;
}

template <typename T>
inline uint8_t force_impl(void* p, const uint8_t* bytes, uint8_t flags,
                          void* lock = nullptr) noexcept {
    const T v = decode_scalar<T>(bytes);
    return force_status(force::set(p, &v, sizeof(T), flags, nullptr, lock));
}

inline void unforce_impl(void* p) noexcept {
    force::clear(p);
}

// Soft write — updates the variable through IECVar::set(). Ignored while the
// leaf is forced, so a force stays authoritative until the user unforces.
//
// Distinct from force_impl: that one pins the variable indefinitely; this
// one writes a value the program can overwrite on the next scan cycle.
// Used by external clients (OPC-UA, future BACnet, etc.) that want
// regular write semantics rather than debugger-style forcing.
template <typename T>
inline void write_impl(void* p, const uint8_t* bytes) noexcept {
    if (force::is_forced(p)) return;
    static_cast<IECVar<T>*>(p)->set(decode_scalar<T>(bytes));
}

// A forced leaf reads its forced value, even mid-cycle after the program
// wrote it.
template <typename T>
inline void read_impl(const void* p, uint8_t* dest) noexcept {
    if (force::read(p, dest, sizeof(T)) == sizeof(T)) return;
    T v = static_cast<const IECVar<T>*>(p)->get();
    std::memcpy(dest, &v, sizeof(T));
}

// Pointer op — the same value read_impl would copy out, addressed in place.
//
// Exists so a caller that can serve a value without owning it (OPC-UA hands
// open62541 a UA_Variant with UA_VARIANT_DATA_NODELETE) does not pay an
// allocation and a copy per read. A forced leaf is served from its force-table
// slot, so the pointer cannot leak a value the program wrote mid-cycle.
//
// The pointer is valid until the variable is next written OR ITS FORCE STATE
// CHANGES, which for a cooperative single-threaded runtime means "until the
// caller yields". A caller that can be preempted by the PLC scan must copy
// instead. A force or an unforce changes WHICH OBJECT the pointer refers to
// (the slot or the variable), so a pointer taken before it is stale after.
template <typename T>
inline const void* ptr_impl(const void* p, uint16_t* len) noexcept {
    uint16_t n = 0;
    const void* forced = force::value_ptr(p, &n);
    *len = static_cast<uint16_t>(sizeof(T));
    if (forced != nullptr && n == sizeof(T)) return forced;
    return static_cast<const IECVar<T>*>(p)->raw_ptr();
}

// STRING / WSTRING live in `IECStringVar<254>` / `IECWStringVar<254>`,
// the wrappers around `IECString<254>` / `IECWString<254>`, which carry their
// own length, capped at 254 bytes / 254 wide code units of storage.
//
// Wire format (matches the editor decoder in
// `src/frontend/utils/variable-sizes.ts` — `len8-utf8` / `len8-utf16le`):
//
//   STRING:  [ uint8 length ][ DEBUG_STRING_CAP bytes UTF-8 payload ]
//            A STRING is stored as Windows-1252 bytes (iec_cp1252.hpp): a read
//            transcodes them to UTF-8, the length is the UTF-8 byte count, and
//            a value whose UTF-8 form passes DEBUG_STRING_CAP is cut before the
//            first character that does not fit whole. A write or force decodes
//            the UTF-8 payload to CP1252; a payload that is not UTF-8, or holds
//            a character CP1252 lacks, is refused with STATUS_NOT_ENCODABLE.
//            ^ 1 byte         ^ 126 bytes (always — content past the
//                               declared length is unused but the
//                               wire width is fixed)
//
//   WSTRING: [ uint8 length ][ DEBUG_STRING_CAP * 2 bytes UTF-16LE ]
//            ^ 1 byte         ^ 252 bytes (126 little-endian code units)
//
// The length prefix is a uint8 because that's what the wire reserves
// (`DEBUG_STRING_CAP = 126` in the editor); a string longer than 126
// is truncated at the boundary on the way out.  The editor reads
// exactly the prefix and uses it to decode `min(length, CAP)` content
// units; the remaining bytes in the fixed window are ignored.
//
// We zero-fill the unused tail of the window on every read so stale
// bus contents from a previous read can't leak into the editor — which
// would otherwise show garbage after the legitimate content if a
// reader misuses the cap.
//
// A forced string's slot holds its characters and a terminating NUL, as code
// units for WSTRING, and its own apply function stores them through the
// string wrapper so the stored length follows.
constexpr uint8_t DEBUG_STRING_CAP   = 126;            // chars / code units
constexpr uint8_t DEBUG_STRING_WIDTH = 1 + DEBUG_STRING_CAP;          // 127 bytes on the wire
constexpr uint8_t DEBUG_WSTRING_WIDTH = 1 + DEBUG_STRING_CAP * 2;     // 253 bytes on the wire

// --- STRING (IECStringVar<254>) ---------------------------------------

/** force::ApplyFn for a STRING leaf: `bytes` are the characters and a NUL. */
inline void apply_string(void* dst, const uint8_t* bytes, uint16_t size) noexcept {
    static_cast<IECStringVar<254>*>(dst)->set(
        IECString<254>(reinterpret_cast<const char*>(bytes), size - 1u));
}

/** Characters and length of a STRING leaf, honouring a force. */
inline const char* string_view_of(const void* p, std::size_t* len) noexcept {
    uint16_t n = 0;
    const void* forced = force::value_ptr(p, &n);
    if (forced != nullptr) {
        *len = n - 1u;
        return static_cast<const char*>(forced);
    }
    const auto* var = static_cast<const IECStringVar<254>*>(p);
    *len = var->length();
    return var->c_str();
}

inline void read_string(const void* p, uint8_t* dest) noexcept {
    std::size_t actual_len = 0;
    const char* src = string_view_of(p, &actual_len);
    const uint8_t wire_len = static_cast<uint8_t>(
        cp1252::to_utf8(src, actual_len, dest + 1, DEBUG_STRING_CAP));
    dest[0] = wire_len;
    if (wire_len < DEBUG_STRING_CAP) {
        std::memset(dest + 1 + wire_len, 0, DEBUG_STRING_CAP - wire_len);
    }
}

/** Decode a STRING wire payload to CP1252 in `out`; false when it cannot be. */
inline bool decode_string(const uint8_t* bytes, char* out, std::size_t* out_len) noexcept {
    const uint8_t wire_len = bytes[0] < DEBUG_STRING_CAP ? bytes[0] : DEBUG_STRING_CAP;
    return cp1252::from_utf8(bytes + 1, wire_len, out, out_len);
}

inline void write_string(void* p, const uint8_t* bytes) noexcept {
    if (force::is_forced(p)) return;
    char value[DEBUG_STRING_CAP];
    std::size_t n = 0;
    if (!decode_string(bytes, value, &n)) return;  // validate_payload refused it
    auto* var = static_cast<IECStringVar<254>*>(p);
    var->set(IECString<254>(value, n));
}

inline uint8_t force_string(void* p, const uint8_t* bytes, uint8_t flags,
                            void* lock = nullptr) noexcept {
    char value[DEBUG_STRING_CAP + 1];
    std::size_t n = 0;
    if (!decode_string(bytes, value, &n)) return STATUS_NOT_ENCODABLE;
    value[n] = '\0';
    return force_status(force::set(p, value, static_cast<uint16_t>(n + 1u),
                                   flags, &apply_string, lock));
}

// The payload only — NOT the [len][payload] wire form read_string() builds.
// `len` is the byte count; a forced leaf is served from its slot. The bytes are
// the stored Windows-1252 characters, one byte each, NOT UTF-8: a caller that
// needs Unicode (an OPC-UA String is UTF-8) transcodes them, e.g. with
// cp1252::to_utf8.
//
// Deliberately NOT capped at DEBUG_STRING_CAP. That cap is the Modbus debug
// FRAME budget: the wire form spends one byte on the length prefix and the
// editor reads a fixed window, so read_string() has to truncate. A pointer
// spends nothing and has no window — the caller (OPC-UA) carries its own
// length — so clamping here would silently shorten a string for a transport
// that never asked for it. `length()` is already bounded by the variable's own
// capacity, which is the only real limit on this path.
// `len` must be non-null; handle_ptr always passes a real address.
inline const void* ptr_string(const void* p, uint16_t* len) noexcept {
    std::size_t n = 0;
    const char* src = string_view_of(p, &n);
    *len = static_cast<uint16_t>(n);
    return src;
}

// --- WSTRING (IECWStringVar<254>) -------------------------------------

/** force::ApplyFn for a WSTRING leaf: `bytes` are host-order code units and a NUL. */
inline void apply_wstring(void* dst, const uint8_t* bytes, uint16_t size) noexcept {
    char16_t buf[DEBUG_STRING_CAP + 1];
    std::memcpy(buf, bytes, size);
    static_cast<IECWStringVar<254>*>(dst)->set(
        IECWString<254>(buf, static_cast<std::size_t>(size / 2u - 1u)));
}

/** Code units and count of a WSTRING leaf, honouring a force. */
inline const char16_t* wstring_view_of(const void* p, std::size_t* len) noexcept {
    uint16_t n = 0;
    const void* forced = force::value_ptr(p, &n);
    if (forced != nullptr) {
        *len = n / 2u - 1u;
        return static_cast<const char16_t*>(forced);
    }
    const auto* var = static_cast<const IECWStringVar<254>*>(p);
    *len = var->length();
    return var->c_str();
}

inline void read_wstring(const void* p, uint8_t* dest) noexcept {
    std::size_t actual_len = 0;
    const char16_t* src = wstring_view_of(p, &actual_len);
    const uint8_t wire_len = static_cast<uint8_t>(
        actual_len < DEBUG_STRING_CAP ? actual_len : DEBUG_STRING_CAP);
    dest[0] = wire_len;
    for (uint8_t i = 0; i < wire_len; ++i) {
        char16_t unit;
        std::memcpy(&unit, src + i, sizeof unit);
        // Little-endian 16-bit code unit — explicit byte split so the
        // wire format is host-endianness-independent (AVR is LE in
        // practice but ARM-BE targets, however rare, would otherwise
        // serialise the wrong way around).
        dest[1 + i * 2]     = static_cast<uint8_t>(unit & 0xFF);
        dest[1 + i * 2 + 1] = static_cast<uint8_t>((unit >> 8) & 0xFF);
    }
    const std::size_t used = 1 + static_cast<std::size_t>(wire_len) * 2;
    if (used < DEBUG_WSTRING_WIDTH) {
        std::memset(dest + used, 0, DEBUG_WSTRING_WIDTH - used);
    }
}

/** Decode `wire_len` little-endian code units from a WSTRING payload. */
inline void decode_wstring(const uint8_t* bytes, uint8_t wire_len, char16_t* out) noexcept {
    for (uint8_t i = 0; i < wire_len; ++i) {
        out[i] = static_cast<char16_t>(bytes[1 + i * 2])
               | static_cast<char16_t>(static_cast<char16_t>(bytes[1 + i * 2 + 1]) << 8);
    }
}

inline void write_wstring(void* p, const uint8_t* bytes) noexcept {
    if (force::is_forced(p)) return;
    auto* var = static_cast<IECWStringVar<254>*>(p);
    const uint8_t wire_len = bytes[0] < DEBUG_STRING_CAP ? bytes[0] : DEBUG_STRING_CAP;
    char16_t buf[DEBUG_STRING_CAP];
    decode_wstring(bytes, wire_len, buf);
    var->set(IECWString<254>(buf, wire_len));
}

inline uint8_t force_wstring(void* p, const uint8_t* bytes, uint8_t flags,
                             void* lock = nullptr) noexcept {
    const uint8_t wire_len = bytes[0] < DEBUG_STRING_CAP ? bytes[0] : DEBUG_STRING_CAP;
    char16_t value[DEBUG_STRING_CAP + 1];
    decode_wstring(bytes, wire_len, value);
    value[wire_len] = u'\0';
    return force_status(force::set(p, value,
                                   static_cast<uint16_t>((wire_len + 1u) * sizeof(char16_t)),
                                   flags, &apply_wstring, lock));
}

// The code-unit buffer as it sits in memory, so `len` is BYTES (2 per code
// unit), not characters. Like ptr_string, NOT capped at DEBUG_STRING_CAP —
// see the note there; the cap belongs to the Modbus frame, not to a pointer.
// `len` must be non-null; handle_ptr always passes a real address.
//
// read_wstring() splits each code unit explicitly to keep the WIRE format
// little-endian on any host. A pointer cannot do that — what the caller gets is
// host order — so this op is only correct on a little-endian target.
//
// The refusal is a RUNTIME one, not a static_assert. At namespace scope an
// unconditional assert fires when the header is INCLUDED, so a big-endian (or
// MSVC, which defines no __BYTE_ORDER__) build of firmware that only ever calls
// handle_read/handle_write stopped compiling — an op nobody referenced taking
// the whole translation unit down with it. Refusing here instead leaves every
// other op available and routes the caller to the copying path, which is what
// the old assertion text told them to do anyway.
#if !defined(__BYTE_ORDER__) || !defined(__ORDER_LITTLE_ENDIAN__) || \
    __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
inline const void* ptr_wstring(const void*, uint16_t* len) noexcept {
    *len = 0;
    return nullptr;   // handle_ptr's contract for "no pointer available"
}
#else
inline const void* ptr_wstring(const void* p, uint16_t* len) noexcept {
    std::size_t n = 0;
    const char16_t* src = wstring_view_of(p, &n);
    *len = static_cast<uint16_t>(n * 2);
    return src;
}
#endif

// BIT member (feature bit_type): bit `bit` of the byte at `p`, one byte 0/1
// on the wire. A forced bit reads its forced value; a soft write to it is
// ignored, as for any forced leaf.
inline uint8_t force_bit(void* p, uint8_t bit, const uint8_t* bytes, uint8_t flags,
                         void* lock) noexcept {
    return force_status(force::set_bit(p, bit, bytes[0] != 0, flags, lock));
}
inline void read_bit(const void* p, uint8_t bit, uint8_t* dest) noexcept {
    bool forced = false;
    if (force::read_bit(p, bit, &forced)) {
        dest[0] = forced ? 1 : 0;
        return;
    }
    dest[0] = static_cast<uint8_t>((*static_cast<const uint8_t*>(p) >> bit) & 1u);
}
inline void write_bit(void* p, uint8_t bit, const uint8_t* bytes) noexcept {
    bool forced = false;
    if (force::read_bit(p, bit, &forced)) return;
    uint8_t* b = static_cast<uint8_t*>(p);
    const uint8_t mask = static_cast<uint8_t>(1u << bit);
    *b = static_cast<uint8_t>(bytes[0] != 0 ? (*b | mask) : (*b & ~mask));
}
inline uint8_t force_bit0(void* p, const uint8_t* bytes, uint8_t flags, void* lock) noexcept {
    return force_bit(p, 0, bytes, flags, lock);
}
inline void unforce_bit0(void* p) noexcept { force::clear_bit(p, 0); }
inline void read_bit0(const void* p, uint8_t* dest) noexcept { read_bit(p, 0, dest); }
inline void write_bit0(void* p, const uint8_t* bytes) noexcept { write_bit(p, 0, bytes); }

/** Pointer op of a leaf with no address of its own (a BIT member). */
inline const void* ptr_none(const void*, uint16_t* len) noexcept {
    *len = 0;
    return nullptr;
}

// ---------------------------------------------------------------------------
// Dispatch table entry. The `size` field is the byte width consumed/produced
// by force/read (for strings: reserved, handled specially).
// ---------------------------------------------------------------------------
struct TypeOps {
    /** Force: variable, value, force::FLAG_*, the lock of its shared global or null. */
    uint8_t (*force)(void*, const uint8_t*, uint8_t, void*);
    void (*unforce)(void*);
    void (*read)   (const void*, uint8_t*);
    void (*write)  (void*, const uint8_t*);
    uint8_t size;
};

/** The pointer op, in a table of its own — see ptr_ops[] below. */
struct PtrOps {
    const void* (*ptr)(const void*, uint16_t*);
};

// ---------------------------------------------------------------------------
// type_ops[]: one row per TypeTag, in tag order.
// Header-scope `constexpr`, so no separate .cpp is required.
//
// NOT flash-resident on AVR, whatever `constexpr` suggests. The Entry
// tables carry STRUCPP_DEBUG_FLASH (see debug_table.hpp) and this does not, so
// on a Harvard target it is const data in .rodata, which the startup code
// copies into SRAM. Every AVR firmware pays for this table.
//
// That is why the pointer op is NOT a column here — see ptr_ops[] below.
//
// Moving this one to STRUCPP_DEBUG_FLASH would mean routing every row read
// through pgm_read_ptr in the hot path of handle_read / handle_write /
// handle_set. Worth doing on its own evidence, not as a side effect.
//
// Plain `constexpr`, not `inline constexpr`, because the runtime is C++14:
// that gives the table internal linkage, one copy per translation unit.
// Harmless while a single TU includes this header — include it from a
// second and an AVR pays for the table twice in SRAM.
// ---------------------------------------------------------------------------
constexpr TypeOps type_ops[TAG__COUNT] = {
    /*BOOL    */ { &force_impl<BOOL_t>,  &unforce_impl, &read_impl<BOOL_t>,  &write_impl<BOOL_t>,  sizeof(BOOL_t)      },
    /*SINT    */ { &force_impl<SINT_t>,  &unforce_impl, &read_impl<SINT_t>,  &write_impl<SINT_t>,  sizeof(SINT_t)      },
    /*USINT   */ { &force_impl<USINT_t>, &unforce_impl, &read_impl<USINT_t>, &write_impl<USINT_t>, sizeof(USINT_t)     },
    /*INT     */ { &force_impl<INT_t>,   &unforce_impl, &read_impl<INT_t>,   &write_impl<INT_t>,   sizeof(INT_t)       },
    /*UINT    */ { &force_impl<UINT_t>,  &unforce_impl, &read_impl<UINT_t>,  &write_impl<UINT_t>,  sizeof(UINT_t)      },
    /*DINT    */ { &force_impl<DINT_t>,  &unforce_impl, &read_impl<DINT_t>,  &write_impl<DINT_t>,  sizeof(DINT_t)      },
    /*UDINT   */ { &force_impl<UDINT_t>, &unforce_impl, &read_impl<UDINT_t>, &write_impl<UDINT_t>, sizeof(UDINT_t)     },
    /*LINT    */ { &force_impl<LINT_t>,  &unforce_impl, &read_impl<LINT_t>,  &write_impl<LINT_t>,  sizeof(LINT_t)      },
    /*ULINT   */ { &force_impl<ULINT_t>, &unforce_impl, &read_impl<ULINT_t>, &write_impl<ULINT_t>, sizeof(ULINT_t)     },
    /*REAL    */ { &force_impl<REAL_t>,  &unforce_impl, &read_impl<REAL_t>,  &write_impl<REAL_t>,  sizeof(REAL_t)      },
    /*LREAL   */ { &force_impl<LREAL_t>, &unforce_impl, &read_impl<LREAL_t>, &write_impl<LREAL_t>, sizeof(LREAL_t)     },
    /*BYTE    */ { &force_impl<BYTE_t>,  &unforce_impl, &read_impl<BYTE_t>,  &write_impl<BYTE_t>,  sizeof(BYTE_t)      },
    /*WORD    */ { &force_impl<WORD_t>,  &unforce_impl, &read_impl<WORD_t>,  &write_impl<WORD_t>,  sizeof(WORD_t)      },
    /*DWORD   */ { &force_impl<DWORD_t>, &unforce_impl, &read_impl<DWORD_t>, &write_impl<DWORD_t>, sizeof(DWORD_t)     },
    /*LWORD   */ { &force_impl<LWORD_t>, &unforce_impl, &read_impl<LWORD_t>, &write_impl<LWORD_t>, sizeof(LWORD_t)     },
    /*TIME    */ { &force_impl<TIME_t>,  &unforce_impl, &read_impl<TIME_t>,  &write_impl<TIME_t>,  sizeof(TIME_t)      },
    /*DATE    */ { &force_impl<DATE_t>,  &unforce_impl, &read_impl<DATE_t>,  &write_impl<DATE_t>,  sizeof(DATE_t)      },
    /*TOD     */ { &force_impl<TOD_t>,   &unforce_impl, &read_impl<TOD_t>,   &write_impl<TOD_t>,   sizeof(TOD_t)       },
    /*DT      */ { &force_impl<DT_t>,    &unforce_impl, &read_impl<DT_t>,    &write_impl<DT_t>,    sizeof(DT_t)        },
    /*STRING  */ { &force_string,        &unforce_impl, &read_string,        &write_string,        DEBUG_STRING_WIDTH  },
    /*WSTRING */ { &force_wstring,       &unforce_impl, &read_wstring,       &write_wstring,       DEBUG_WSTRING_WIDTH },
    // BIT: the handlers below take the bit number from the entry; this row gives its width.
    /*BIT     */ { &force_bit0,          &unforce_bit0, &read_bit0,          &write_bit0,          1                   },
};

// ---------------------------------------------------------------------------
// ptr_ops[]: the pointer op, deliberately NOT a sixth column of type_ops.
//
// Only handle_ptr reads this, and only the baremetal OPC-UA server calls
// handle_ptr — but as a column it was reachable from handle_read/handle_write
// too, so the whole table grew for every firmware. Measured on an ATmega2560
// (arduino:avr:mega, the simulator's target) with a sketch that only ever calls
// handle_read/handle_write: 383 -> 425 bytes of SRAM and 4654 -> 5128 of flash.
//
// Split out, nothing references this table unless handle_ptr is called, and
// -ffunction-sections/-fdata-sections + --gc-sections (which the AVR core
// passes) drop both it and the ptr_impl<T> instantiations.
//
// Measured on arduino:avr:mega, same sketch, same runtime tree:
//
//   never calls handle_ptr   383 B SRAM / 4728 B flash   (was 425 / 5128)
//   calls handle_ptr         425 B SRAM / 5196 B flash
//
// So the feature now costs what it costs, and only to firmware that uses it.
// ---------------------------------------------------------------------------
constexpr PtrOps ptr_ops[TAG__COUNT] = {
    /*BOOL    */ { &ptr_impl<BOOL_t> },
    /*SINT    */ { &ptr_impl<SINT_t> },
    /*USINT   */ { &ptr_impl<USINT_t> },
    /*INT     */ { &ptr_impl<INT_t> },
    /*UINT    */ { &ptr_impl<UINT_t> },
    /*DINT    */ { &ptr_impl<DINT_t> },
    /*UDINT   */ { &ptr_impl<UDINT_t> },
    /*LINT    */ { &ptr_impl<LINT_t> },
    /*ULINT   */ { &ptr_impl<ULINT_t> },
    /*REAL    */ { &ptr_impl<REAL_t> },
    /*LREAL   */ { &ptr_impl<LREAL_t> },
    /*BYTE    */ { &ptr_impl<BYTE_t> },
    /*WORD    */ { &ptr_impl<WORD_t> },
    /*DWORD   */ { &ptr_impl<DWORD_t> },
    /*LWORD   */ { &ptr_impl<LWORD_t> },
    /*TIME    */ { &ptr_impl<TIME_t> },
    /*DATE    */ { &ptr_impl<DATE_t> },
    /*TOD     */ { &ptr_impl<TOD_t> },
    /*DT      */ { &ptr_impl<DT_t> },
    /*STRING  */ { &ptr_string },
    /*WSTRING */ { &ptr_wstring },
    /*BIT     */ { &ptr_none },  // never called: handle_ptr refuses a BIT leaf first
};

// ---------------------------------------------------------------------------
// Per-project tables are declared in `debug_table.hpp` (which we
// include above).  They live there — not here — because the table-emit
// translation unit (`generated_debug.cpp`) needs the `extern`
// declarations to force external linkage on its `const` definitions,
// and pulling `debug_dispatch.hpp` into generated_debug.cpp drags
// `<avr/pgmspace.h>` → `<avr/io.h>` into a TU that names user
// variables.  See debug_table.hpp's preamble for the rationale.
//
// On AVR these tables are in PROGMEM; the accessors below use
// pgm_read_*_far() when the chip exposes RAMPZ (Mega2560, ATmega32U4,
// ATmega1280, etc.) and fall back to near pgm_read_word() on the
// atmega328p / atmega168 family (Uno, Nano, Pro Mini), whose entire
// flash always fits in 16 bits.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// read_entry(): fetches Entry for (array_idx, elem_idx).
// On AVR uses PROGMEM reads (far when the chip has RAMPZ, near otherwise);
// elsewhere a plain array access. Returns {nullptr, 0} on out-of-bounds so
// callers can cheaply check.
//
// `defined(RAMPZ)` is the same predicate avr-libc's <avr/pgmspace.h> uses to
// gate declarations of `pgm_read_*_far` and `pgm_get_far_address`. Chips
// without RAMPZ (atmega328p / atmega168 family — Uno, Nano, Pro Mini) lack
// the ELPM instruction and the avr-libc headers don't expose the _far
// variants, so referencing them is a hard compile error. Chips with RAMPZ
// (atmega2560 — Mega, atmega1280, atmega32u4 — Micro / Leonardo, etc.)
// keep the far-addressing path since their tables may live above 64 KB
// (Mega) or because the same code is benign-but-correct when flash is
// ≤64 KB (32u4: ELPM with RAMPZ=0 behaves as LPM).
// ---------------------------------------------------------------------------
inline Entry read_entry(uint8_t arr, uint16_t elem) noexcept {
    Entry out{nullptr, 0, 0};
    if (arr >= debug_array_count) return out;

#if defined(__AVR__) && defined(RAMPZ)
    // Fetch elem count (uint16_t in PROGMEM) first
    uint32_t counts_base = pgm_get_far_address(debug_array_counts);
    uint16_t count = pgm_read_word_far(counts_base + arr * sizeof(uint16_t));
    if (elem >= count) return out;

    // Fetch Entry* (pointer-to-PROGMEM, 16-bit on AVR but stored in far flash)
    uint32_t arrays_base = pgm_get_far_address(debug_arrays);
    // pointers in PROGMEM are 16-bit near pointers on AVR (entry arrays live
    // in their own PROGMEM regions which near pointers can still reach, since
    // each array < 32 KB. But debug_arrays itself can be far.)
    uintptr_t table_ptr = pgm_read_word_far(arrays_base + arr * sizeof(void*));

    // Read the 4-byte Entry. We assume the array is in the lower 64 KB; if
    // it's past, we would need pgm_read_word_far on the element too. For
    // Phase 4a we accept the <64 KB constraint per entry array.
    const uint8_t* entry_addr = reinterpret_cast<const uint8_t*>(table_ptr) + elem * sizeof(Entry);
    uintptr_t ptr_val = pgm_read_word(entry_addr);
    uint8_t tag_val   = pgm_read_byte(entry_addr + sizeof(void*));
    // `flags` sits immediately after `tag` — both uint8_t, no padding between
    // them — so it is the byte after the tag. MUST be read here: the AVR paths
    // assemble `out` field by field rather than copying the struct, and a
    // missed flags read silently returns 0, which reads as "writable" and
    // defeats the CONSTANT gate on exactly the targets with the least memory
    // to spare for a second lookup.
    out.flags = pgm_read_byte(entry_addr + sizeof(void*) + 1);
    out.ptr = reinterpret_cast<void*>(ptr_val);
    out.tag = tag_val;
#elif defined(__AVR__)
    // AVR without RAMPZ — flash is ≤64 KB on these chips, so every PROGMEM
    // address fits in a 16-bit pointer and near accessors are sufficient.
    uint16_t count = pgm_read_word(&debug_array_counts[arr]);
    if (elem >= count) return out;

    const Entry* table = reinterpret_cast<const Entry*>(pgm_read_word(&debug_arrays[arr]));
    const uint8_t* entry_addr = reinterpret_cast<const uint8_t*>(table) + elem * sizeof(Entry);
    uintptr_t ptr_val = pgm_read_word(entry_addr);
    uint8_t tag_val   = pgm_read_byte(entry_addr + sizeof(void*));
    out.flags = pgm_read_byte(entry_addr + sizeof(void*) + 1);
    out.ptr = reinterpret_cast<void*>(ptr_val);
    out.tag = tag_val;
#else
    uint16_t count = debug_array_counts[arr];
    if (elem >= count) return out;
    out = debug_arrays[arr][elem];
#endif
    return out;
}

/** debug_array_kind[arr]: DEBUG_ARRAY_GLOBAL or DEBUG_ARRAY_PROGRAM. Same
 *  flash accessors as read_entry(); `arr` must be in range. */
inline uint8_t read_array_kind(uint8_t arr) noexcept {
#if defined(__AVR__) && defined(RAMPZ)
    return pgm_read_byte_far(pgm_get_far_address(debug_array_kind) + arr);
#elif defined(__AVR__)
    return pgm_read_byte(&debug_array_kind[arr]);
#else
    return debug_array_kind[arr];
#endif
}

// ---------------------------------------------------------------------------
// Per-entry operations. These are what ModbusSlave / Runtime v4 call.
// ---------------------------------------------------------------------------

/**
 * The lock of the shared global leaf (arr, elem) lives in, or null: only a
 * STRUCPP_THREADED build has one (the generated debug_leaf_lock()).
 */
inline void* leaf_lock(uint8_t arr, uint16_t elem) noexcept {
#ifdef STRUCPP_THREADED
    return read_array_kind(arr) == DEBUG_ARRAY_GLOBAL ? debug_leaf_lock(arr, elem)
                                                      : nullptr;
#else
    (void)arr;
    (void)elem;
    return nullptr;
#endif
}

/** Holds a shared global's lock for one debugger access; a no-op for null. */
class LeafGuard {
public:
    explicit LeafGuard(void* lock) noexcept : lock_(lock) {
#ifdef STRUCPP_THREADED
        if (lock_ != nullptr) static_cast<std::mutex*>(lock_)->lock();
#endif
    }
    ~LeafGuard() {
#ifdef STRUCPP_THREADED
        if (lock_ != nullptr) static_cast<std::mutex*>(lock_)->unlock();
#endif
    }
    LeafGuard(const LeafGuard&) = delete;
    LeafGuard& operator=(const LeafGuard&) = delete;

private:
    void* lock_;
};

/**
 * Validate a value payload against a leaf's type. Returns STATUS_OK, or the
 * STATUS_* refusal to hand straight back to the caller. Shared by handle_set()
 * and handle_write() so the rule cannot drift between them.
 *
 * Scalars are fixed-width: `len` must cover the type's size.
 *
 * Strings are length-prefixed: `bytes[0]` is the UTF-8 byte (STRING) or
 * code-unit (WSTRING) count, and force_string / write_string read exactly that
 * many, so `len` must cover `1 + count` -- `1 + 2 * count` for WSTRING -- and
 * NOT `type_ops[tag].size`, which is the padded width the READ path emits. A
 * count past DEBUG_STRING_CAP is refused rather than silently truncated.
 *
 * `len` is a lower bound throughout, so a caller that pads to the full field
 * width still passes.
 */
inline uint8_t validate_payload(uint8_t tag, const uint8_t* bytes, uint16_t len) noexcept {
    const uint8_t expected = type_ops[tag].size;
    if (expected == 0) return STATUS_DATA_TOO_LARGE;
    if (!bytes) return STATUS_DATA_TOO_LARGE;

    if (tag == TAG_STRING || tag == TAG_WSTRING) {
        const uint8_t count = bytes[0];
        if (count > DEBUG_STRING_CAP) return STATUS_DATA_TOO_LARGE;
        const uint16_t need = static_cast<uint16_t>(
            1u + (tag == TAG_WSTRING ? static_cast<uint16_t>(count) * 2u
                                     : static_cast<uint16_t>(count)));
        if (len < need) return STATUS_DATA_TOO_LARGE;
        if (tag == TAG_STRING) {
            char value[DEBUG_STRING_CAP];
            std::size_t n = 0;
            if (!decode_string(bytes, value, &n)) return STATUS_NOT_ENCODABLE;
        }
        return STATUS_OK;
    }

    if (len < expected) return STATUS_DATA_TOO_LARGE;
    return STATUS_OK;
}

/** Set (force or unforce) a variable. Returns STATUS_OK, or the refusal:
 *  STATUS_OUT_OF_BOUNDS, STATUS_READ_ONLY, STATUS_DATA_TOO_LARGE, or
 *  STATUS_FORCE_TABLE_FULL when every force-table slot the value needs is taken,
 *  or STATUS_NOT_ENCODABLE for a STRING payload CP1252 cannot hold. */
inline uint8_t handle_set(uint8_t arr, uint16_t elem, bool forcing,
                          const uint8_t* bytes, uint16_t len) noexcept {
    Entry e = read_entry(arr, elem);
    if (!e.ptr || e.tag >= TAG__COUNT) return STATUS_OUT_OF_BOUNDS;

    // A CONSTANT cannot be forced. Refused for BOTH directions: unforcing a
    // leaf that could never be forced is a no-op, and returning OK for it
    // would tell the caller a force had been cleared that never existed.
    if (e.flags & LEAF_FLAG_READONLY) return STATUS_READ_ONLY;

    if (forcing) {
        const uint8_t bad = validate_payload(e.tag, bytes, len);
        if (bad != STATUS_OK) return bad;
        const uint8_t flags =
            read_array_kind(arr) == DEBUG_ARRAY_GLOBAL ? force::FLAG_GLOBAL : 0;
        if (e.tag == TAG_BIT) {
            return force_bit(e.ptr, leaf_bit(e.flags), bytes, flags, leaf_lock(arr, elem));
        }
        return type_ops[e.tag].force(e.ptr, bytes, flags, leaf_lock(arr, elem));
    }
    if (e.tag == TAG_BIT) {
        force::clear_bit(e.ptr, leaf_bit(e.flags));
        return STATUS_OK;
    }
    type_ops[e.tag].unforce(e.ptr);
    return STATUS_OK;
}

/** Read one variable into `dest`. Writes type_ops[tag].size bytes.
 *  Returns bytes written, or 0 on out-of-bounds. */
inline uint16_t handle_read(uint8_t arr, uint16_t elem, uint8_t* dest) noexcept {
    Entry e = read_entry(arr, elem);
    if (!e.ptr || e.tag >= TAG__COUNT) return 0;
    uint8_t n = type_ops[e.tag].size;
    if (n == 0) return 0;  // string stub
    LeafGuard guard(leaf_lock(arr, elem));
    if (e.tag == TAG_BIT) {
        read_bit(e.ptr, leaf_bit(e.flags), dest);
        return n;
    }
    type_ops[e.tag].read(e.ptr, dest);
    return n;
}

/** Soft write (non-forcing). Updates the underlying value via
 *  IECVar::set(). If the variable is currently forced (it has a force-table
 *  slot), the write is silently ignored — forcing remains authoritative
 *  until unforced.
 *  This matches OPC-UA / BACnet write semantics: the next scan cycle
 *  may overwrite the written value, unlike force which pins it.
 *  Returns STATUS_* code. */
inline uint8_t handle_write(uint8_t arr, uint16_t elem,
                            const uint8_t* bytes, uint16_t len) noexcept {
    Entry e = read_entry(arr, elem);
    if (!e.ptr || e.tag >= TAG__COUNT) return STATUS_OUT_OF_BOUNDS;
    // Same gate as handle_set. This is also the path the retain restore walk
    // uses, so a CONSTANT can never be clobbered by a stale retained value
    // either — constants come from the declaration, never from storage.
    if (e.flags & LEAF_FLAG_READONLY) return STATUS_READ_ONLY;
    const uint8_t bad = validate_payload(e.tag, bytes, len);
    if (bad != STATUS_OK) return bad;
    LeafGuard guard(leaf_lock(arr, elem));
    if (e.tag == TAG_BIT) {
        write_bit(e.ptr, leaf_bit(e.flags), bytes);
        return STATUS_OK;
    }
    type_ops[e.tag].write(e.ptr, bytes);
    return STATUS_OK;
}

/** Variable size for (arr, elem) — 0 if unknown/out-of-bounds. */
inline uint16_t handle_size(uint8_t arr, uint16_t elem) noexcept {
    Entry e = read_entry(arr, elem);
    if (!e.ptr || e.tag >= TAG__COUNT) return 0;
    return type_ops[e.tag].size;
}

/** Address a leaf's value in place; `out_len` receives its length in BYTES.
 *  Returns nullptr (and sets *out_len = 0) for an out-of-range leaf.
 *
 *  The copy-free counterpart to handle_read(). The pointer is into live PLC
 *  storage, so it is valid only until the variable is next written or its force
 *  state changes — safe for a caller that runs inside the scan's own thread of
 *  control, wrong for one that can be preempted by it.
 *
 *  Returns nullptr with *out_len = 0 when the leaf has no address to give:
 *  an unknown (arr, elem), a tag with no ptr op, or WSTRING on a big-endian
 *  target (see ptr_wstring). */
inline const void* handle_ptr(uint8_t arr, uint16_t elem, uint16_t* out_len) noexcept {
    Entry e = read_entry(arr, elem);
    if (!e.ptr || e.tag >= TAG__COUNT) {
        if (out_len) *out_len = 0;
        return nullptr;
    }
    // A BIT member has no address of its own.
    if (e.tag == TAG_BIT) {
        if (out_len) *out_len = 0;
        return nullptr;
    }
    uint16_t len = 0;
    const void* p = ptr_ops[e.tag].ptr(e.ptr, &len);
    if (out_len) *out_len = len;
    return p;
}

/** Total number of arrays. */
inline uint8_t handle_array_count() noexcept {
    return debug_array_count;
}

/** Element count for a given array — 0 if `arr` out-of-bounds.
 *  AVR branch mirrors `read_entry` above: RAMPZ-equipped chips use far
 *  accessors, others fall back to near reads. */
inline uint16_t handle_elem_count(uint8_t arr) noexcept {
    if (arr >= debug_array_count) return 0;
#if defined(__AVR__) && defined(RAMPZ)
    uint32_t counts_base = pgm_get_far_address(debug_array_counts);
    return pgm_read_word_far(counts_base + arr * sizeof(uint16_t));
#elif defined(__AVR__)
    return pgm_read_word(&debug_array_counts[arr]);
#else
    return debug_array_counts[arr];
#endif
}

} } // namespace strucpp::debug

// ---------------------------------------------------------------------------
// C-linkage shims for the OpenPLC Runtime v4 .so interface.
//
// The runtime dlopen()s a libplc_<hash>.so and dlsym()s these symbols to
// speak the debug protocol without needing the C++ strucpp::debug namespace.
//
// Usage: in the .so's packaging step (Phase 5), compile ONE .cpp with
//
//     #define STRUCPP_V4_DEBUG_EXPORTS_DEFINE
//     #include "debug_dispatch.hpp"
//
// The symbols use `attribute((used, visibility("default")))` so they're
// retained even under LTO and appear in the dynamic symbol table.
//
// Embedded targets (Arduino) should NOT define the macro — the Flash cost
// of these extra symbols is unnecessary there (the ModbusSlave calls
// handle_* directly via C++ linkage).
// ---------------------------------------------------------------------------
#ifdef STRUCPP_V4_DEBUG_EXPORTS_DEFINE
#define STRUCPP_V4_EXPORT __attribute__((used, visibility("default")))

extern "C" {

STRUCPP_V4_EXPORT uint8_t strucpp_debug_array_count(void) {
    return strucpp::debug::handle_array_count();
}

STRUCPP_V4_EXPORT uint16_t strucpp_debug_elem_count(uint8_t arr) {
    return strucpp::debug::handle_elem_count(arr);
}

STRUCPP_V4_EXPORT uint16_t strucpp_debug_size(uint8_t arr, uint16_t elem) {
    return strucpp::debug::handle_size(arr, elem);
}

// handle_ptr() is deliberately NOT exported here. It hands out a pointer into
// live PLC storage, which is only safe for a caller running inside the scan's
// own thread of control — true of the baremetal super-loop, false of the
// Runtime v4 .so, where the scan runs in its own thread and a plugin reading
// through the pointer would race it. Linux callers use strucpp_debug_read().

STRUCPP_V4_EXPORT uint8_t strucpp_debug_set(uint8_t arr, uint16_t elem,
                                             bool forcing,
                                             const uint8_t *bytes,
                                             uint16_t len) {
    return strucpp::debug::handle_set(arr, elem, forcing, bytes, len);
}

STRUCPP_V4_EXPORT uint16_t strucpp_debug_read(uint8_t arr, uint16_t elem,
                                               uint8_t *dest) {
    return strucpp::debug::handle_read(arr, elem, dest);
}

STRUCPP_V4_EXPORT uint8_t strucpp_debug_write(uint8_t arr, uint16_t elem,
                                               const uint8_t *bytes,
                                               uint16_t len) {
    return strucpp::debug::handle_write(arr, elem, bytes, len);
}

} // extern "C"

#undef STRUCPP_V4_EXPORT
#endif // STRUCPP_V4_DEBUG_EXPORTS_DEFINE
