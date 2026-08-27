---
name: jsdoc-union-narrowing-needs-explicit-compare
description: The pinned TS 7 preview does not narrow a JSDoc boolean-literal discriminated union on truthiness — `!res.ok` fails the gate, `res.ok === false` narrows; compare explicitly.
metadata:
  type: project
---

# JSDoc discriminated unions: narrow with `=== false`, not `!x.ok`

When a JSDoc-typed function returns a discriminated union over a boolean literal
(`{ ok: true, … } | { ok: false, … }`), guard the failure arm with an explicit comparison
(`if (res.ok === false)`) — never with truthiness (`if (!res.ok)`).

**Why:** During the transactional-rename work (2026-08-26), `renameTransaction.js`'s `apply()`
returns `ApplySuccess | ApplyFailure` discriminated on `ok: true | ok: false` (JSDoc typedefs).
The pinned `typescript@7.0.2` preview narrowed the union under `res.ok === false` and under an
`in` check, but **not** under `!res.ok` — that spelling failed `npm run typecheck` with
`TS2345: Argument of type 'ApplyFailure | ApplySuccess' is not assignable to parameter of type
'ApplyFailure'`, verified with a minimal repro. Stable TypeScript narrows both spellings, so this
reads like a bug and someone will be tempted to "clean up" the explicit comparison.

**How to apply:** Use `=== true` / `=== false` (or an `in` check on an arm-specific property)
wherever a JSDoc union must narrow, and leave a one-line comment at the site so the explicit
comparison survives review (done at the `txn.apply()` call sites in
`src/commands/renameCommands.js`). If the gate ever moves off the TS 7 preview, this rule can be
re-tested before being dropped. Sibling trap: [[typecheck-graph-grows-with-requires]] — the same
pinned parser also mis-parses Closure-style `function()` JSDoc types.
