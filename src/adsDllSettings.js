/**
 * @file adsDllSettings.js
 * @description Where Beckhoff's ADS DLLs are, for a machine where TC Toolkit's own search does not find
 * them (user request 2026-11-16). Two settings, machine-scoped like the XAE Shell paths, both empty by
 * default (empty = search as before):
 *   - `tcToolkit.adsDll.dotNetLibrary`: the .NET `TwinCAT.Ads.dll` the user-mode fallback's PowerShell
 *     helper loads (resources/online/ads-helper.ps1, `-AdsDll`).
 *   - `tcToolkit.adsDll.nativeDllFolder`: the folder holding the native `TcAdsDll.dll` (`…\TwinCAT\Common64`):
 *     the helper puts it on PATH (`-AdsNativeDir`), and the XAE driver's ADS state reads load it from
 *     there (resources/xae/build-plc-project.ps1, `-AdsDllDir`: the RUN check after activation and the
 *     activation targets' AmsNetId confirmation).
 * A configured path is used on its own: when it does not exist the scripts say so and do NOT fall back
 * to the search, so a mistyped setting is reported instead of being hidden by a DLL found elsewhere.
 * The hints below name the setting; the callers add an "Open Setting" button where they notify.
 */

'use strict';

/** The settings section (its title in the Settings editor is "ADS DLLs"). */
const ADS_DLL_SECTION = 'tcToolkit.adsDll';
/** The .NET TwinCAT.Ads.dll (file). */
const SETTING_ADS_DOTNET_LIBRARY = 'tcToolkit.adsDll.dotNetLibrary';
/** The folder holding the native TcAdsDll.dll. */
const SETTING_ADS_NATIVE_DLL_FOLDER = 'tcToolkit.adsDll.nativeDllFolder';

/** The usual locations, as the descriptions and hints name them. */
const USUAL_MANAGED_PATH = 'C:\\Program Files (x86)\\Beckhoff\\TwinCAT\\3.1\\Components\\Base\\v170\\TwinCAT.Ads.dll';
const USUAL_NATIVE_FOLDER = 'C:\\Program Files (x86)\\Beckhoff\\TwinCAT\\Common64';

/**
 * The two settings, trimmed ('' = search).
 * @param {(key: string) => unknown} get Reads a key of the `tcToolkit.adsDll` section.
 * @returns {{dotNetLibrary: string, nativeDllFolder: string}}
 */
function readAdsDllSettings(get) {
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.trim() : '');
    return { dotNetLibrary: str(get('dotNetLibrary')), nativeDllFolder: str(get('nativeDllFolder')) };
}

/**
 * One or two sentences: what to set (or correct) when a DLL was not found or did not load.
 * @param {'managed'|'native'} which `managed` = TwinCAT.Ads.dll, `native` = TcAdsDll.dll.
 * @param {{configured?: boolean}} [o] `configured`: the path came from the setting.
 * @returns {string}
 */
function adsDllHint(which, o = {}) {
    const setting = which === 'managed' ? SETTING_ADS_DOTNET_LIBRARY : SETTING_ADS_NATIVE_DLL_FOLDER;
    if (o.configured) {
        return `The path in the setting ${setting} is used as given: correct it, or clear it to let TC Toolkit search the usual folders.`;
    }
    return which === 'managed'
        ? `If TwinCAT is installed elsewhere, set ${setting} to its TwinCAT.Ads.dll (usually ${USUAL_MANAGED_PATH}).`
        : `If TwinCAT is installed elsewhere, set ${setting} to the folder holding TcAdsDll.dll (usually ${USUAL_NATIVE_FOLDER}).`;
}

/**
 * Whether a driver text (an activation's DLL problem, a runtime's "not offered" reason) says that
 * TcAdsDll.dll was not found, as Read-TcAdsState words it.
 * @param {unknown} text
 * @returns {boolean}
 */
function isNativeDllMissing(text) {
    return typeof text === 'string' && /TcAdsDll\.dll\) was not found/.test(text);
}

module.exports = {
    ADS_DLL_SECTION, SETTING_ADS_DOTNET_LIBRARY, SETTING_ADS_NATIVE_DLL_FOLDER, USUAL_MANAGED_PATH, USUAL_NATIVE_FOLDER,
    readAdsDllSettings, adsDllHint, isNativeDllMissing
};
