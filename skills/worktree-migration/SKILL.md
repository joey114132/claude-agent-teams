---
name: worktree-migration
description: "Use when one mechanical change, such as a library upgrade, an API rename or a framework bump, has to be applied across 5 to 40 modules of a repository whose build and test commands are green today, and the result should be one reviewed, passing git branch per module for the user to merge. Plans items with boundaries and dependencies, groups them into waves, migrates each item in its own git worktree, and accepts a branch only after a deterministic build and test run, a scan for silenced checks and a blind semantic review, with a planted failing worktree proving the gate can fail. Never merges. Not for a single-file or few-file edit, for data migrations or schema changes against a live database (use the database-migrations skill and a human), for a repo with no green baseline, or for semantic refactors whose items interact in non-mechanical ways."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Worktree Migration

Act as the orchestrator of a migration team: you scope, hand over, and assemble; you do not edit the modules yourself. The `database-migrations` skill owns live-schema and data changes. The `code-review` skill owns reviewing a diff you wrote by hand. This skill owns when a mechanical change across many modules is worth a team, how the waves are formed, and how much of a "passing" branch to believe.

The team is four agents and one script: `agents/migration-planner.md` (read-only, lists items), `agents/migration-worker.md` (one per item, own worktree and branch), `agents/migration-gate-runner.md` (Bash only, runs the build and tests and reports raw numbers), `agents/migration-reviewer.md` (blind, read-only) and `workflows/worktree-migration.js` (the wiring and every cap).

## How to answer

- **Verdict first.** Say whether a team is warranted, then the plan. If the answer is "one agent is enough", say that in the first sentence and do the work that way.
- **Ask for what is missing, once.** The run needs the migration description with before and after examples, the build command, the test command, and the paths of the decision records. If the build is not green today, stop: the first job is the user's, not the team's.
- **After the run, report the branches, not the feeling.** Passed branches in merge order, BLOCKED items with their reasons, skipped dependents, anything dropped by a cap, and what was never verified.
- **Never merge, push or delete for the user.** The run leaves branches. Merging is theirs.

## The migration decision sequence

1. **Does this need a team?** Fan out when one mechanical change touches 5 to 40 modules and each module's result can be checked by a build and tests. For fewer than five, one agent in a loop is cheaper. Above 40, split the migration by directory and run it twice.
2. **Is the baseline green?** Build and tests pass on the untouched checkout, and the working tree is clean (the worktrees are cut from `HEAD`). The workflow checks this first and returns `baseline_red` or `baseline_dirty` without changing anything.
3. **Fix the records.** List decision records: ADRs, intent files, troubleshooting notes, handoff notes. Frozen or deprecated modules live there. Agents start cold and will migrate a module a record says to leave alone.
4. **Plan.** The planner returns items as `{id, files, boundary, depends, risk}`. Code, not an agent, validates them, rejects cycles and overlapping boundaries between any two items with no dependency path between them, and builds the waves by topological layering. Modules the planner cannot classify come back as `unclassified` and are left for a human.
5. **Prove the gate can fail.** One scratch worktree gets a deliberately breaking edit (an undefined symbol or a failing assertion) and goes through the real gate. The build and the tests must both reject it: a test command that cannot fail (`true`) aborts the run with `canary_failed` before it touches a real item. The silence scanner and the diff completeness check also have a self-test on a synthetic diff.
6. **Migrate wave by wave.** Inside a wave each item streams on its own: worker, then gate, then reviewer. There is no barrier between items. There is one between waves. It is a deliberate simplification: a wave-2 item needs only its own dependencies' branches, so an unrelated slow or BLOCKED wave-1 item delays it for nothing.
7. **Stop at the caps and say what was dropped.** An item that fails its gate or review after 2 worker retries is BLOCKED, and everything that depends on it is skipped.

## Shape

```
baseline (gate-runner) -> planner -> waves by code -> canary worktree -> gate must reject
wave 1: item a: worker -> gate -> review ┐
        item b: worker -> gate -> review ┤ no barrier between items
        item c: worker -> gate -> review ┘
 ---- barrier: wave 2 builds on the merged results of wave 1 ----
wave 2: item d (depends on a): worker merges migrate/a first -> gate -> review
```

## Roles and caps

| Role | Does | Tools | Cap |
|---|---|---|---|
| Orchestrator (you) | scope, records, hand-over, report | read | 1 |
| migration-planner | items, boundaries, dependencies, canary proposal | Read, Grep, Glob | 1 |
| migration-worker | one item in its own worktree on `migrate/<id>` | Read, Edit, Write, Bash | 5 worktrees at once, 40 items, 2 retries per item |
| migration-gate-runner | build, tests, diff, git facts; no judgment | Bash | one per attempt, plus baseline and canary |
| migration-reviewer | blind PASS or failure list | Read, Grep, Glob | 3 rounds per item |

All caps are enforced in `workflows/worktree-migration.js`. A caller can lower them and never raise them. The runtime has no clock, so the wall-clock limit is the caller's: `timeout 7200 claude -p ...`. Each gate command also runs under `timeout` (`gateTimeoutSec`, default and maximum 1800).

## Run it

Launch from inside the repository, because the worktrees are cut from the session's working directory. Preferred: the Workflow tool with `scriptPath: '${CLAUDE_SKILL_DIR}/../../workflows/worktree-migration.js'` and `args` `{root, description, build, test, records}`. Optional: `maxItems`, `concurrency`, `maxRetries`, `maxRounds`, `gateTimeoutSec`, `canary: {file, append}`, `prepare`. A limit that is not a positive integer returns `bad_limits` instead of becoming the maximum. `prepare` is a shell command run in every fresh worktree before the build (for JS or Python repos an install, or `ln -s "$MIGRATION_ROOT/node_modules" node_modules`); the original checkout is `$MIGRATION_ROOT`. Worktrees start without installed dependencies, so without it the first gate fails for reasons unrelated to the migration. It must leave only git-ignored files (a `node_modules` symlink is not matched by a `node_modules/` ignore line). The baseline runs in the checkout as it is. Add `agentPrefix: ""` for a symlink or `--plugin-dir` install; the default is `agent-teams:`.

The result carries `merge_order`, `passed`, `blocked`, `skipped`, `dropped`, `truncated` (a previous diff cut to 20000 characters for a retrying worker), `unclassified`, `leftover_branches`, `canary`, `caps` and a `report`. A branch that depends on another already contains it, and items with no dependency path between them have disjoint boundaries, so merging in `merge_order` is clean. Blocked items keep their branches for inspection; nothing is deleted.

## Evidence

None measured on a real repository yet. The workflow has been exercised only against a stubbed agent layer (caps, canary, retries, review rounds, skipped dependents, argument errors). Treat the first real run as the experiment and read its `report` before merging anything.

## Where the pattern comes from

Reimplemented from ideas, no text copied: Boundary and Depends annotations, dependency-wave batching and capped retries then BLOCKED from https://github.com/gotalab/cc-sdd (MIT); start from green, one concern per wave with a recorded rollback commit, never silence a check, never auto-commit from https://github.com/maddhruv/absolute (MIT); each task verified before commit, rejections returned to the owner from https://github.com/shinpr/claude-code-workflows (MIT); worktree isolation and limits from https://code.claude.com/docs/en/sub-agents.

## Gotchas

- **A green gate means nothing until a red one is shown.** The canary exists because a build command that exits 0 without compiling the changed files looks identical to a good migration. If the canary file is not compiled or tested by your commands, the run aborts with `canary_failed`; pass `canary: {file, append}` for a file they do load.
- **Silence is cheaper than a fix, and workers know it.** The usual shortcut is a `@ts-ignore`, a skipped test, a loosened assertion or `|| true`. The scan runs in code over the diff the gate-runner returns, so the worker cannot argue past it. The diff is text an LLM copied, so code first requires every changed file to appear in it, the git and worker file lists to agree, and every hunk to hold the line count its header announces; an item with a cut diff fails as `diff_incomplete`. The assertion count looks at test files only and ignores `require`, but it still reads two `expect` lines folded into one `toEqual` as a removal: that item blocks and needs a human look, it is not weakened. It matches patterns, so a migration whose purpose is to remove such markers will trip it on legitimate edits: raise it with the user, do not weaken the scan.
- **Boundaries must not overlap between unrelated items.** Two items with no dependency path between them, in the same wave or not, editing the same file produce branches that conflict when merged by hand. The workflow rejects the plan (`plan_invalid`) and asks for a `depends` edge. A shared barrel file or lockfile is the usual cause.
- **Waves are a real edge, not a convenience.** A wave-2 worker merges its dependency branches and is gated against that merge, so the first BLOCKED item in wave 1 skips everything downstream. Do not shrink dependencies to avoid skips: an item compiled against the unmigrated API passes a wrong gate.
- **The tree must be clean and committed.** Worktrees are cut from `HEAD`, so uncommitted edits in the main checkout are invisible to every worker and the baseline would not describe them. The run refuses a dirty baseline and fails any item whose worktree has untracked or modified files after the worker finishes.
- **A lower test count is a failure even with exit code 0.** Disabled tests are the quiet way to go green. If the runner prints a total, an item that runs fewer tests than the baseline fails. If your runner prints no total, this check is off (the run logs a warning) and the assertion-count scan is the only guard.
- **The reviewer is not calibrated.** Only the gate has a canary. A reviewer that passes everything looks the same as one that is right, so read the diffs of high-risk items yourself before merging.
- **BLOCKED branches are left behind on purpose.** Every attempt has its own branch (`migrate/<id>`, `migrate/<id>-a2`, ...) and none is deleted. Clean them up by hand when you have looked.
