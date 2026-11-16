---
name: symlinked-node-modules-test-another-tree
description: A symlinked node_modules in a worktree resolves `strucpp -> ../..` to the original clone, so tests silently run other code. Use `cp -al`, then check `readlink -f`.
metadata:
  type: feedback
---

Never give a git worktree a symlinked `node_modules` (or `vscode-extension/node_modules`). Copy it
with `cp -al <clone>/…/node_modules <worktree>/…/node_modules`, then verify with
`readlink -f <worktree>/vscode-extension/node_modules/strucpp`: it must print the worktree itself.

**Why:** on 2026-11-14 the fork's gate worktrees had `vscode-extension/node_modules` as a symlink
into an old clone. The package links itself as `strucpp -> ../..`, and `../..` resolved relative to
the symlink's *target*, so every extension test in those worktrees loaded the old clone's compiler.
Three branches merged with a green "vscode-extension" gate that never tested their code (fork #157,
#159, #162); the problem only surfaced when a later branch's gate failed on tests that came from a
merged lexer change the old clone did not have. Combined builds run with the root `vitest` did not
catch it either: the extension suite is a separate package.

**How to apply:** when creating any worktree for a gate or review, `cp -al` both `node_modules`
directories, and run the `readlink -f` check before trusting a test result. A gate that passes the
extension tests in under a minute on a branch that touched the compiler deserves a second look.
