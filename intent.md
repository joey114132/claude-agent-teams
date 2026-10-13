# Intent

## Why this exists

Multi-agent setups usually fail in boring ways. A single agent anchors on the first plausible cause. A fan-out copies one blind spot six times. A reviewer approves what the writer wrote because both are the same kind of model. A loop runs until the budget is gone. A "verified" result comes from a checker that has never been seen to say no.

This plugin packages teams where those failure modes are designed out. Each team has a stated shape and a reason for it, each role has the least power it needs, every team whose output reaches a person ends in a read-only critic, and every cap lives in code. It is general-purpose software work (defect sweeps, debugging, design decisions, postmortems, test quality, migrations) and is the sibling of claude-robotics-skills, which covers robots.

## Success, observable

- Installing with `/plugin marketplace add joey114132/claude-agent-teams` gives six skills, 28 agents and six workflow scripts, and `claude plugin validate .` passes.
- Each team skill fires on a prompt in its own domain and stays out of the way on a prompt that belongs to a cheaper path or to a neighbouring team. `claude plugin eval . --tag routing` shows this per case, and EVAL.md holds the dated numbers.
- A run either returns a result whose checkers were shown to say no (canary caught) or returns an `error` such as `canary_failed`. It never returns an empty "clean" result.
- Anything a cap cut off appears in the return value (`notChecked`, `dropped`, `cells_not_run`, `caps_applied`). A reader can tell a partial run from a clean one.
- Each skill opens with a decision on whether a team is worth its cost, and for a small task it says one agent is enough.

## Failure, observable

- A verifier confirms a planted false finding and the run still reports confirmed results.
- A cap is raised by caller input, or a dropped item is not reported.
- A critic or verifier edits a file or runs a command.
- A team skill fires on a one-file or one-diff task where one agent would do.
- A script reads a clock or a random source, so that two runs of the same input differ for reasons nobody can inspect.
- Text from a third-party source is copied without an `Adapted from <url> (<license>)` line and a README notice.

## Out of scope

- Robots, ROS and hardware. Use claude-robotics-skills. `hypothesis-duel` says so in its own description.
- Fixing as a side effect. `defect-hunt-until-dry` reports and stops, and fixing is a separate step the user approves.
- Merging, pushing, publishing or deleting. `worktree-migration` leaves one branch per module and the user merges.
- Live data or schema migrations, security incidents that need legal review or chain of custody, and incidents still in progress.
- A generic agent catalogue. An agent exists only as a role inside a team with a shape. Duplicates of agents already in this repo or in claude-robotics-skills are not added.
- Model-specific tuning. `model` appears in an agent file only when it matters, and effort is left to the caller.
- Measured quality claims. Routing is evaluated. Result quality on real repositories is not yet measured (see open questions).

## Invariants and their evidence

| Invariant | Why | Evidence |
|---|---|---|
| Critics, skeptics, jurors, verifiers and refuters have only Read, Grep and Glob | A judge that can edit quietly fixes things instead of reporting them | `tools: Read, Grep, Glob` in the `tools:` line (line 4) of `agents/adr-critic.md`, `blameless-critic.md`, `root-cause-critic.md`, `hunt-report-critic.md`, `test-suite-critic.md`, `defect-skeptic.md`, `design-juror.md`, `timeline-event-verifier.md`, `alternative-cause-refuter.md`, `migration-reviewer.md` |
| Every verifying team plants a canary and aborts when it is confirmed | A checker never seen to say no proves nothing | `canary_failed` returns at `workflows/defect-hunt-until-dry.js:433`, `design-panel.js:288`, `hypothesis-duel.js:332`, `incident-timeline-postmortem.js:334` and `:430`, `spec-mutation-tests.js:462` |
| Caller input can lower a cap and never raise it | Caps bound cost and are decided before launch, not negotiated by the prompt | `HARD` tables at `workflows/design-panel.js:48` and `hypothesis-duel.js:42`; the stated rule at `hypothesis-duel.js:16` |
| Critic loops are at most three rounds | Looping to agreement produces drift, not quality | `rounds: 3` in `HARD` at `design-panel.js:48` and `hypothesis-duel.js:42`; `CRITIC_ROUNDS = 3` at `defect-hunt-until-dry.js:55` |
| Workflow scripts use no clock or random source | A script with a clock cannot be reproduced, so wall time is bounded by a timeout on the call | `workflows/defect-hunt-until-dry.js:19`; the `Date.now` and `Math.random` grep over `workflows/` is empty |
| `agentPrefix` defaults to `agent-teams:` and accepts `""` | A plugin install namespaces agents, a symlink install does not | `PREFIX` at `defect-hunt-until-dry.js:34`, `design-panel.js:30`, `hypothesis-duel.js:58` |
| Skills list their Workflow path as `${CLAUDE_SKILL_DIR}/../../workflows/<file>.js` | The same skill works from a plugin cache or a checkout | Step "Run it" in each `skills/*/SKILL.md` |
| Nodes that judge are told which decision records to read | Agents start cold and reopen closed questions | `records` arg in every workflow header and the "List the decision records" step in each skill |

## Decisions and reasons

- **Workflow scripts, not prompt choreography.** Caps, dedupe, sorting, arithmetic and canary checks are code because an agent doing arithmetic invents numbers and a prompt cap is advisory.
- **One skill per team, with a "does this need a team" step first.** Most tasks do not need more than one agent, and the skill that cannot say so costs more than it saves.
- **Pipeline by default, barrier only on a real edge.** A barrier waits for the slowest node. It is used for dedupe over all findings, scoring over all proposals, and the whole verified timeline, and each use is commented in the script.
- **Blind verification.** A verifier is given one claim and not its author, so it cannot defer to it.
- **Ideas reimplemented, not copied.** The licenses of the sources vary (MIT, Apache-2.0, CC BY-SA 4.0, all rights reserved). Reimplementing the idea keeps this repository MIT without a notice for each file, and each source is still cited in README.
- **Separate repository from the robotics collection.** The robotics skills carry live searches and hardware safety rules that do not belong in a general plugin.

## Open questions

- **Quality on real repositories.** Only `worktree-migration` says so outright ("None measured on a real repository yet"), but the same holds for every team: the workflows were exercised against a stubbed agent layer. How to check: run each on a repository with known planted defects and compare against a single-agent baseline.
- **Does the canary rate matter?** Each team plants one canary per run. Whether one is enough to calibrate a verifier on a large run is untested. How to check: plant several and compare confirmation rates.
- **Cost per run.** Agent counts are capped, but token cost per team on a typical repository has not been measured. How to check: run with usage logging and publish the numbers in EVAL.md.
- **Routing for near-miss prompts.** Cases exist for `hypothesis-duel` against a stack-trace bug, against a sweep and against a postmortem, and for `design-panel` against a rename. The other four teams have a positive case only. How to check: add a negative case for each.
- **Release gate.** The release needs the routing evals to pass for every case, and EVAL.md records which have been run.
