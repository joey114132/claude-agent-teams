---
name: spec-mutation-tests
description: "Use when a spec, README guarantee or design doc exists and the code behind it needs tests that would catch a real regression, not tests that merely pass: 'write tests for this spec and prove they can fail', mutation-test a generated suite, find which promised behaviours no test would notice breaking. Splits the spec into requirements, writes tests per requirement in parallel, proves them with a mutation run in a git worktree (baseline, sentinel, mutants), feeds survivors back for up to 3 rounds, then has a judge sort equivalent mutants from real gaps and a read-only critic review. Not for UI snapshot code, code without a deterministic test runner, flaky or network-bound suites, a spec you do not trust, or writing a handful of tests for one function (one agent is cheaper)."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Spec to Tests with a Mutation Gate

Act as the orchestrator: you plan, delegate and assemble, and you write no tests yourself. The test writer is the same kind of model that approves tests when asked, so the grader here is the test runner. A mutant either dies or survives, and no model opinion decides that. For other jobs use the tdd or test-engineering skills you already have. This skill owns the case where the question is "can these tests fail?".

The team is six agents, one workflow: `agents/spec-requirement-extractor.md`, `agents/spec-test-writer.md`, `agents/mutant-proposer.md`, `agents/mutation-runner.md`, `agents/equivalent-mutant-judge.md`, `agents/test-suite-critic.md` and `workflows/spec-mutation-tests.js`.

## Decision sequence

1. **Does this need a team?** Fan out only for a spec with several independent guarantees (about 4 or more) and code you can run deterministically. For one function or one guarantee, one agent writing tests and you checking by hand is cheaper. Say which you chose.
2. **Is the suite deterministic?** Run the test command twice yourself. A flaky or network-bound suite fails the baseline gate on purpose, so stop here and say so instead of launching.
3. **Do you trust the spec?** Tests encode it. If the spec is stale or disputed, say that the result is only as good as the spec, and prefer fixing the spec first.
4. **Gather inputs.** Spec paths, source paths, the test command (include `{files}` where the runner should insert one requirement's test files; without it the whole suite runs and the result says `suite_scope: whole suite`), the test directory, and the decision-record paths (intent, ADRs, troubleshooting notes). Agents start cold and will contradict a record they were not told about.
5. **Run it.** Workflow with `scriptPath: '${CLAUDE_SKILL_DIR}/../../workflows/spec-mutation-tests.js'` and `args` `{root, specs, sources, testCommand, testDir, records}` as an object. Add `agentPrefix: ""` for bare agent installs; the default `agent-teams:` fits a plugin install. Launch from inside the project repository and wrap it in a wall-clock limit such as `timeout 3600 claude -p ...`, because the script has no clock. Without the Workflow tool, say so; do not imitate the loop by hand with unbounded agents.
6. **Report from the result, per requirement.** Lead with an `error` if there is one (`canary_failed`, judge canary). Then the `real_gaps` with file and line, `spec_code_conflicts` (the code contradicts the spec, which may be a real bug), `unmapped` and `undecidable` requirements, `notChecked`, and the critic's failures. Never boil the run down to one coverage number.

## Shape and why

A pipeline per requirement, not a stage-by-stage barrier. Requirements are independent, so each one streams through write, mutate and run without waiting for slower ones. Test writing and mutant proposing have no edge between them (the proposer reads only code), so they run together. The loop around the pipeline is an evaluator-optimizer whose grader is the test runner. The only barrier is at the end, because the equivalent-mutant judge and the critic need the whole survivor table.

| Role | Does | Tools | Cap |
|---|---|---|---|
| Orchestrator (you) | inputs, assembly, report | read | 1 |
| spec-requirement-extractor | quotes and maps requirements | read, search | 1 |
| spec-test-writer | tests for one requirement | read, write, edit, bash (test directory only) | one per requirement, 4 at a time by default |
| mutant-proposer | up to 5 mutants and a sentinel as diffs | read, search | one per requirement |
| mutation-runner | baseline, sentinel, mutants in a worktree, raw results | bash | one call per requirement per round |
| equivalent-mutant-judge | EQUIVALENT or REAL_GAP per survivor, blind to tests | read, search | batches of 10 |
| test-suite-critic | PASS or failure list | read, search | 1 pass |

## Caps, all enforced in the script

30 requirements, 5 mutants each, 3 rounds, 1 retry per requirement (for a red baseline, a sentinel that survives or tests that were removed), 300 agent calls, at most 8 concurrent writers and runners. Callers can lower these and never raise them. Whatever a cap drops comes back under `notChecked` and in the log. The critic gets one pass: a repair round would re-enter a loop whose 3 rounds are already spent, so its failures are returned as open objections for a rerun on those requirements.

## Canaries

Before any real mutant, the runner applies a sentinel that makes the mapped function raise or return a constant. A suite that cannot fail on it is not exercising the code (wrong path, skipped tests, bad runner), so after one writer retry the whole run aborts with `canary_failed` instead of printing a wall of survivors. That abort needs a sentinel that applied and survived. A sentinel diff that does not apply is the proposer's fault: it gets one corrected proposal, and if that fails too the requirement is `unmeasured` and the run goes on. A second canary, a real mutant that a suite test killed by assertion, is listed in the survivor table like any other row and slipped into every judge batch. It must come back REAL_GAP. If it comes back EQUIVALENT, no judge verdict counts.

## Gotchas

- **Only labelled tests earn credit.** A kill, or a sentinel failure, counts only when the failing test's id carries the requirement id (`R3`). Tests that were already in the suite cannot raise the score, and a requirement whose passing tests carry no id goes back to the writer once.
- **No mutant run means unmeasured.** A requirement where no mutant was killed or left standing (every diff failed to apply, or every run was inconclusive) is `unmeasured`, never `done`, and the critic cannot pass the run while one exists.
- **A mutant is killed only by an assertion.** An import error, a timeout or a crash on a mutant is `inconclusive`, never a kill, and it stays in the score's denominator. Counting crashes inflates the score without proving the tests check anything.
- **Green baseline first, decided by code.** The runner refuses to continue on a red baseline, and the script re-derives green from exit code and test lists. A flaky suite fails here on purpose, so do not retry it until it passes.
- **Later rounds may only add tests.** The runner counts assertions with `grep` and lists passing test ids each round; a shrinking count or a lost id rejects the round, and the writer gets one retry to restore from its backups. Without this, the cheapest way to kill survivors is to weaken the tests that exposed them.
- **Equivalent mutants are real.** A survivor may be unobservable (dead branch, value overwritten before use). Chasing it makes the writer produce contorted tests. The judge, who cannot see the tests, decides, and proof of equivalence needs a cited reason or the answer is REAL_GAP.
- **Sentinel success is not test quality.** It only proves the suite reaches the code. A suite can kill the sentinel and still have weak assertions, which is why the critic and the per-requirement scores exist.
- **A conflict is a finding.** If the code contradicts a requirement, the writer reports `conflict` and writes no test. Do not tell it to match the code. List these under `spec_code_conflicts`, because either the spec or the code is wrong.
- **Scores are per requirement.** A global percentage hides the one unprotected guarantee. Report which requirements have REAL_GAP survivors, and say unmapped requirements got no tests at all.
- **The runner holds a shell, so its fence is an instruction.** It works in its own `git worktree` under the work directory and the script checks every file the writer reports against the test directory, but nothing sandboxes either role. Run it on a clean checkout, never on a machine with production credentials.
- **Worktrees are removed on every exit path.** The runner cleans up before returning a red baseline or a surviving sentinel, and clears a leftover worktree at the same path before it starts. Anything it could not remove is listed under `leftover_worktrees`.
- **The worktree copies source from the working tree.** Uncommitted source edits are included on purpose. Untracked files outside the listed `sources` and `testDir` are not, so a missing helper shows up as a red baseline.

## Sources

Ideas only, no text or code copied: per-requirement fan-out with structured records, from trailofbits/skills `spec-to-code-compliance` (https://github.com/trailofbits/skills/tree/main/plugins/spec-to-code-compliance, CC BY-SA 4.0); the "prove it" test pattern from addyosmani/agent-skills (https://github.com/addyosmani/agent-skills, MIT); retries help when the feedback signal is a trusted external one such as unit tests, from Reflexion (https://arxiv.org/abs/2303.11366, abstract only); never silence a check and repeat runs to expose flakiness, from maddhruv/absolute (https://github.com/maddhruv/absolute, MIT).
