/**
 * @file cppToolsSelection.js
 * @description Whether Microsoft's C/C++ extension will actually use TC Toolkit's configuration provider
 * (src/cppToolsProvider.js) for a workspace folder. Registering a provider is not enough: the C/C++
 * extension only consults the one a configuration names — `configurationProvider` in the active
 * configuration of `.vscode/c_cpp_properties.json`, or, where that is absent or `${default}`, the
 * `C_Cpp.default.configurationProvider` setting. vscode-free: test/test_cpptools_selection.js drives it.
 */

'use strict';

/** The setting the C/C++ extension falls back to (section `C_Cpp`, key `default.configurationProvider`). */
const CPP_SECTION_NAME = 'C_Cpp';
const PROVIDER_SETTING_KEY = 'default.configurationProvider';

/** The configuration file of a workspace folder, relative to it. */
const PROPERTIES_RELATIVE = ['.vscode', 'c_cpp_properties.json'];

/**
 * Whether the next non-blank character from `from` closes an object or array.
 * @param {string} s
 * @param {number} from
 */
function closesNext(s, from) {
    let k = from;
    while (k < s.length && /\s/.test(s[k])) k++;
    return s[k] === '}' || s[k] === ']';
}

/**
 * Parses JSON with comments and trailing commas (the C/C++ extension accepts both). Null when it is
 * still not JSON.
 * @param {string} text
 * @returns {any}
 */
function parseJsonc(text) {
    if (typeof text !== 'string') return null;
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
        } else {
            out += c;
            i++;
        }
    }
    // Trailing commas before } or ], outside strings.
    let clean = '';
    for (let k = 0; k < out.length; k++) {
        const c = out[k];
        if (c === '"') {
            let j = k + 1;
            while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
            clean += out.slice(k, j + 1);
            k = j;
        } else if (c === ',' && closesNext(out, k + 1)) {
            // a trailing comma: dropped
        } else {
            clean += c;
        }
    }
    out = clean.replace(/^\uFEFF/, '');
    try { return JSON.parse(out); } catch (e) { return null; }
}

/**
 * The configuration the C/C++ extension starts with on this platform (its getConfigIndexForPlatform):
 * the one named exactly `Win32` / `Mac` / `Linux`, else the LAST. (A configuration the user picked in
 * the status bar is remembered by the C/C++ extension where this cannot see it.)
 * @param {any[]} configurations
 * @param {string} platform
 */
function platformConfiguration(configurations, platform) {
    const wanted = platform === 'win32' ? 'Win32' : (platform === 'darwin' ? 'Mac' : 'Linux');
    return configurations.find(c => c && c.name === wanted) || configurations[configurations.length - 1];
}

/**
 * The provider a configuration names explicitly: a string other than `${default}` (`''` included),
 * else null (the setting applies). Not trimmed: the C/C++ extension does not trim it either.
 * @param {any} config
 * @returns {string|null}
 */
function namedProvider(config) {
    const named = config ? config.configurationProvider : undefined;
    return typeof named === 'string' && named !== '${default}' ? named : null;
}

/**
 * What a folder's c_cpp_properties.json says about the provider. As in the C/C++ extension
 * (updateConfigurationString): an absent value or `${default}` falls back to the setting; an empty
 * string is "no provider" and does NOT fall back.
 * @param {string|null} text The file's text, or null when there is no file.
 * @param {string} platform
 * @returns {{exists: false} | {exists: true, readable: boolean, provider: string|null,
 *   others: Array<{name: string, provider: string}>}}
 *   `provider`: what the platform's configuration names (`''`: none, explicitly); null: the setting
 *   applies. `others`: the OTHER configurations that name a provider explicitly (the user may have
 *   picked one of them in the status bar, which this cannot see).
 */
function providerFromProperties(text, platform) {
    if (text === null || text === undefined) return { exists: false };
    const parsed = parseJsonc(text);
    if (!parsed || !Array.isArray(parsed.configurations) || parsed.configurations.length === 0) {
        return { exists: true, readable: false, provider: null, others: [] };
    }
    const config = platformConfiguration(parsed.configurations, platform);
    const others = [];
    for (const c of parsed.configurations) {
        const p = c === config ? null : namedProvider(c);
        if (p !== null) others.push({ name: c && typeof c.name === 'string' ? c.name : '', provider: p });
    }
    return { exists: true, readable: true, provider: namedProvider(config), others };
}

/**
 * What to offer for one workspace folder. Provider ids are compared EXACTLY, as the C/C++ extension
 * looks them up (a differently-cased or padded id selects no provider there). In the file, the
 * provider's display name also counts: the C/C++ extension rewrites it to the id (checkId).
 * @param {{extensionId: string, providerName?: string, settingValue: unknown, propertiesText: string|null, platform: string}} o
 *   `settingValue`: `C_Cpp.default.configurationProvider` as read for that folder.
 * @returns {{action: 'none'} | {action: 'setting', current: string|null, nearMiss?: string}
 *   | {action: 'file', named: string|null, configuration?: string, nearMiss?: string}}
 *   `none`: TC Toolkit is already the provider; `setting`: setting the folder's setting would make it so;
 *   `file`: the c_cpp_properties.json decides (names another provider — `named`; names none with
 *   `""` or cannot be read — `named` null; `configuration`: set when it is not the platform's
 *   configuration but another one in the file that names `named`). `nearMiss`: the value that equals
 *   the id only ignoring case or surrounding blanks.
 */
function providerSelection(o) {
    const ours = (/** @type {unknown} */ v) => v === o.extensionId;
    const oursInFile = (/** @type {unknown} */ v) => ours(v) || (!!o.providerName && v === o.providerName);
    const near = (/** @type {unknown} */ v) => (typeof v === 'string' && !ours(v)
        && v.trim().toLowerCase() === o.extensionId.toLowerCase() ? { nearMiss: v } : {});
    const props = providerFromProperties(o.propertiesText, o.platform);
    if (props.exists) {
        if (!props.readable) return { action: 'file', named: null };
        if (props.provider !== null) {
            return oursInFile(props.provider) ? { action: 'none' } : { action: 'file', named: props.provider || null, ...near(props.provider) };
        }
    }
    if (ours(o.settingValue)) return { action: 'none' };
    // The setting would fix the platform's configuration, but another configuration names a provider of
    // its own: if that one is active, the setting changes nothing, so do not promise it.
    const other = props.exists ? props.others.find(c => !oursInFile(c.provider)) : undefined;
    if (other) return { action: 'file', named: other.provider || null, configuration: other.name, ...near(other.provider) };
    return {
        action: 'setting',
        current: typeof o.settingValue === 'string' && o.settingValue.trim() ? o.settingValue : null,
        ...near(o.settingValue)
    };
}

module.exports = {
    CPP_SECTION_NAME, PROVIDER_SETTING_KEY, PROPERTIES_RELATIVE,
    parseJsonc, providerFromProperties, providerSelection
};
