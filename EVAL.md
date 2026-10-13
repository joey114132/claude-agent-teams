# Routing eval results

Routing cases live in `evals/route-*`. Each has a prompt and one or more `tool_used` graders on the `Skill` tool. A positive case needs the team skill to fire. A negative case needs it not to fire (`min: 0`, `max: 0`).

Command, one case per invocation:

```
claude plugin eval . --no-publish --tag routing --ablation none --runs 2 --case 'route-<id>'
```

Raw output of each run is written to `evals/results/<timestamp>/` (git-ignored).

## 2026-10-13

Claude Code 2.1.296. Run `2026-10-13T00-43-43Z`, 33 s, USD 0.45, `--case 'route-design-panel*'`, 2 runs per case, ablation none.

| Case | Kind | Runs | Pass | Score |
|---|---|---|---|---|
| route-design-panel | skill must fire | 2 | 2 of 2 | 1.0 |
| route-design-panel-rename | skill must not fire | 2 | 2 of 2 | 1.0 |

Both cases ran on the plugin as it was before README.md, intent.md and the manifest descriptions were added. No skill, agent or workflow file changed since, so the routing inputs are the same.

Each run also logged `exit 1: Reached maximum number of turns (3)`. The case sets `maxTurns: 3` on purpose, so the run stops after the routing decision, and the grader still scored it.

## Not yet run

These eight cases have no result. On 2026-10-13 every one of the eight invocations stopped before running with:

```
Error: <plugin dir> is not a trusted plugin directory, and this run cannot stop to ask you about it (no interactive terminal, or --json / CI). ... pass --trust-plugin to assert that you trust this plugin's code and eval suite
```

The plugin owner has to give that trust, either by running one case once in an interactive terminal or by adding `--trust-plugin` after reading the suite. No result below is claimed.

| Case | Kind | Result |
|---|---|---|
| route-defect-hunt-until-dry | skill must fire | 2 of 2 |
| route-hypothesis-duel | skill must fire | 1 of 2 (the failing run invoked no skill and started reading files) |
| route-hypothesis-duel-stacktrace | hypothesis-duel must not fire | 2 of 2 |
| route-hypothesis-duel-vs-hunt | hunt fires, duel does not | 2 of 2 |
| route-hypothesis-duel-vs-postmortem | postmortem fires, duel does not | 2 of 2 |
| route-incident-timeline-postmortem | skill must fire | 2 of 2 |
| route-spec-mutation-tests | skill must fire | 2 of 2 |
| route-worktree-migration | skill must fire | 2 of 2 |

## Not measured

Routing says the right skill is picked. It says nothing about the quality of what a team returns. No workflow has been run against a real repository, only against a stubbed agent layer. See the open questions in [intent.md](intent.md).


**Re-run 2026-10-13 with `--trust-plugin`:** the eight cases above that had stopped on the non-interactive trust prompt. Seven route as intended in 2 of 2 runs. `route-hypothesis-duel` routed in 1 of 2; in the other run no skill was invoked at all, so it is a stability gap, not a collision. All workflows also passed stubbed dry runs (272 checks), which exercise wiring, caps, canaries and critic-round stops, not real model behaviour.
