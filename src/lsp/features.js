/**
 * @file features.js
 * @description LSP language feature implementations: completions, definitions, references, highlights, diagnostics.
 *
 * Thin facade over the focused modules in features/. Re-exports the public API unchanged so
 * server.js (and the test harnesses) can keep requiring './features'.
 *
 * The facade exists for require-path stability; features/core.js is the real shared interface
 * between the feature modules.
 */

const { provideCompletions } = require('./features/completions');
const { provideDefinition } = require('./features/definition');
const { provideReferences, provideReferencesForSymbol, clearStFileCache } = require('./features/references');
const { findConfigReferencesForSymbol } = require('./features/configReferences');
const { provideDocumentHighlights } = require('./features/highlights');
const { provideDiagnostics, setDiagnosticsConfig } = require('./features/diagnostics');

module.exports = {
    provideCompletions,
    provideDefinition,
    provideReferences,
    provideReferencesForSymbol,
    findConfigReferencesForSymbol,
    provideDocumentHighlights,
    provideDiagnostics,
    setDiagnosticsConfig,
    clearStFileCache
};
