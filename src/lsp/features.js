/**
 * @file features.js
 * @description LSP language feature implementations: completions, definitions, references, highlights, diagnostics.
 *
 * Thin facade over the focused modules in features/. Re-exports the public API unchanged so
 * server.js (and the test harnesses) can keep requiring './features'.
 */

const { provideCompletions } = require('./features/completions');
const { provideDefinition } = require('./features/definition');
const { provideReferences, provideReferencesForSymbol, clearStFileCache } = require('./features/references');
const { provideDocumentHighlights } = require('./features/highlights');
const { provideDiagnostics, setDiagnosticsConfig } = require('./features/diagnostics');

module.exports = {
    provideCompletions,
    provideDefinition,
    provideReferences,
    provideReferencesForSymbol,
    provideDocumentHighlights,
    provideDiagnostics,
    setDiagnosticsConfig,
    clearStFileCache
};
