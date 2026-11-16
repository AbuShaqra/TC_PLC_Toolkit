// SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception
// Copyright (c) 2026 Autonomy®
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
//
// KEEP THIS HEADER C++14-CLEAN: iec_string.hpp includes it (see the warning
// there).
/**
 * STruC++ Runtime - Windows-1252 character encoding
 *
 * A STRING holds one Windows-1252 (CP1252) byte per character. These helpers
 * map a byte to its Unicode code point and back, and transcode between CP1252
 * bytes and UTF-8 for the places that hand text to a host in UTF-8: the debug
 * wire (read_string / write_string / force_string) and the REPL.
 *
 * Bytes 0x00-0x7F and 0xA0-0xFF are the code points of the same value. Bytes
 * 0x80-0x9F are the CP1252 characters (0x80 is U+20AC); the five unassigned
 * ones (0x81, 0x8D, 0x8F, 0x90, 0x9D) stand for the C1 control of the same
 * value, as in the WHATWG windows-1252 decoder.
 */

#pragma once

#include <cstddef>
#include <cstdint>

namespace strucpp {
namespace cp1252 {

/** Code point of the CP1252 bytes 0x80-0x9F (64 bytes of const data; SRAM on AVR). */
inline uint16_t high_code_point(unsigned char byte) noexcept {
    static const uint16_t table[32] = {
        0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
        0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
        0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
        0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
    };
    return table[byte - 0x80u];
}

/** The Unicode code point a CP1252 byte stands for. */
inline uint32_t to_unicode(unsigned char byte) noexcept {
    return (byte >= 0x80u && byte <= 0x9Fu) ? high_code_point(byte) : byte;
}

/** The CP1252 byte of a code point, or -1 when CP1252 has none. */
inline int from_unicode(uint32_t cp) noexcept {
    if (cp < 0x80u || (cp >= 0xA0u && cp <= 0xFFu)) return static_cast<int>(cp);
    for (unsigned b = 0x80u; b <= 0x9Fu; ++b) {
        if (high_code_point(static_cast<unsigned char>(b)) == cp) return static_cast<int>(b);
    }
    return -1;
}

/** Number of UTF-8 bytes a code point below U+10000 takes. */
inline std::size_t utf8_width(uint32_t cp) noexcept {
    return cp < 0x80u ? 1u : (cp < 0x800u ? 2u : 3u);
}

/**
 * Write CP1252 `src[0..n)` as UTF-8 into `out`, at most `cap` bytes. Stops
 * before a character whose bytes would not all fit, so the output never ends
 * inside a character. Returns the number of bytes written.
 */
inline std::size_t to_utf8(const char* src, std::size_t n, uint8_t* out,
                           std::size_t cap) noexcept {
    std::size_t w = 0;
    for (std::size_t i = 0; i < n; ++i) {
        const uint32_t cp = to_unicode(static_cast<unsigned char>(src[i]));
        const std::size_t width = utf8_width(cp);
        if (w + width > cap) break;
        if (width == 1u) {
            out[w++] = static_cast<uint8_t>(cp);
        } else if (width == 2u) {
            out[w++] = static_cast<uint8_t>(0xC0u | (cp >> 6));
            out[w++] = static_cast<uint8_t>(0x80u | (cp & 0x3Fu));
        } else {
            out[w++] = static_cast<uint8_t>(0xE0u | (cp >> 12));
            out[w++] = static_cast<uint8_t>(0x80u | ((cp >> 6) & 0x3Fu));
            out[w++] = static_cast<uint8_t>(0x80u | (cp & 0x3Fu));
        }
    }
    return w;
}

/**
 * Decode UTF-8 `src[0..n)` into CP1252 bytes in `out` (room for `n` bytes is
 * always enough). Returns false, leaving `out` unspecified, when the input is
 * not well-formed UTF-8, holds a character CP1252 lacks, or holds a NUL: a
 * STRING ends at its first NUL, so one inside the text would cut it short.
 * `*out_len` is the number of bytes written on success.
 */
inline bool from_utf8(const uint8_t* src, std::size_t n, char* out,
                      std::size_t* out_len) noexcept {
    std::size_t w = 0;
    std::size_t i = 0;
    while (i < n) {
        const uint8_t b0 = src[i];
        uint32_t cp = 0;
        std::size_t extra = 0;
        if (b0 == 0u) {
            return false;  // a NUL would end the STRING inside the text
        } else if (b0 < 0x80u) {
            cp = b0;
        } else if ((b0 & 0xE0u) == 0xC0u) {
            cp = b0 & 0x1Fu;
            extra = 1;
        } else if ((b0 & 0xF0u) == 0xE0u) {
            cp = b0 & 0x0Fu;
            extra = 2;
        } else {
            return false;  // a 4-byte sequence is outside CP1252, or not UTF-8
        }
        if (i + extra >= n) return false;  // truncated sequence
        for (std::size_t k = 1; k <= extra; ++k) {
            const uint8_t b = src[i + k];
            if ((b & 0xC0u) != 0x80u) return false;
            cp = (cp << 6) | (b & 0x3Fu);
        }
        if (extra > 0 && cp < (extra == 1 ? 0x80u : 0x800u)) return false;  // overlong
        const int byte = from_unicode(cp);
        if (byte < 0) return false;
        out[w++] = static_cast<char>(byte);
        i += 1 + extra;
    }
    *out_len = w;
    return true;
}

}  // namespace cp1252
}  // namespace strucpp
