/**
 * @file The TC Toolkit mark as inline SVG for the webviews (user decision 2026-11-16): the geometric
 * "TC" of scripts/logo/tc-toolkit-mark.svg without its tile, the letters in `currentColor` (so it
 * follows the theme) and the square in true red #E2001A, the one marker. Inline because the webviews
 * are offline (no remote image, nothing for the CSP to allow). Used by the editor header and the
 * start page's title. Pure string building, no `vscode`.
 */
'use strict';

/**
 * @param {{height: number, cls?: string, title?: string}} o `height` in CSS pixels; the width follows
 *   the mark's aspect. With `title` the mark is an image named by it, otherwise decorative.
 * @returns {string} The `<svg>` element.
 */
function brandMarkSvg(o) {
    const h = o.height;
    const w = Math.round(h * 210 / 136 * 10) / 10;
    const a11y = o.title
        ? `role="img" aria-label="${String(o.title).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
        : 'aria-hidden="true" focusable="false"';
    return `<svg class="${o.cls || 'brand-mark'}" viewBox="26 60 210 136" width="${w}" height="${h}" ${a11y}>`
        + '<g fill="none" stroke="currentColor" stroke-width="26"><path d="M32 79H104M68 79V190"/>'
        + '<path d="M208.4 95.2A49 49 0 1 0 208.4 160.8"/></g>'
        + '<rect x="203" y="115" width="26" height="26" rx="4" fill="#E2001A"/></svg>';
}

module.exports = { brandMarkSvg };
