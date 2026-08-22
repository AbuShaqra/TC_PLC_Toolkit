---
name: typecheck-graph-grows-with-requires
description: A file can pass the typecheck gate for weeks and still break it later — tsc only sees what src/ requires, and the pinned TS 7 preview mis-parses Closure-style function() JSDoc types
metadata:
  type: project
---

# The typecheck gate's file set is not fixed — and the TS 7 preview parser has JSDoc holes

## Incident (Phase 8, 2026-08-22)

`media/pendingEdits.js` was authored, harness-gated, and committed with `npm run typecheck` green.
One task later, adding `require('../media/pendingEdits')` to `src/customEditorProvider.js` turned
the gate red — `media/pendingEdits.js(133,24): error TS1005: '}' expected` — on a file whose
diff was empty. Two things combined:

1. **The tsc program grows with the require graph.** Nothing under `src/` had required the file
   before, so the earlier green gate had never parsed it. "This file passed typecheck when it was
   committed" is only true relative to the require graph *at that commit*.
2. **The pinned `typescript@7.0.2` (Go-native preview) mis-parses a 4-arg Closure-style JSDoc
   function type** — `@param {function(string, Object, string, string): string} replace`.
   Bisection showed the failure only manifests when compiled together with the full
   `src/customEditorProvider.js`; the same two files are clean under `typescript@5.6.3`. A
   compiler-state bug, not a code defect.

## Rules

- When a change adds a `require` that pulls a file into the tsc program for the first time,
  treat that file as newly gated — a red typecheck on an untouched file is *your* change's
  trigger, and bisection + a TS 5 cross-check separates "tooling bug" from "real defect".
- In this repo, avoid Closure-style `function(...): T` JSDoc types; use a `@callback` typedef
  (same information, parses clean, better docs). `foldEdits` in `media/pendingEdits.js` is the
  precedent.
