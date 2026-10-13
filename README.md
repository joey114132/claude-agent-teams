# claude-agent-teams

Agents, team skills and Workflow scripts for Claude Code that are built around architecture rather than prompts. Each team has a named shape (fan-out, pipeline, loop-until-dry, judge panel) and a reason for that shape. Each role gets only the tools it needs. Every team whose output reaches a person ends in a read-only critic. Caps, retries and stop rules live in the script, so no agent can talk its way past them.

The teams are general-purpose software work: defect sweeps, root-cause debugging, design decisions, postmortems, test quality and large mechanical migrations. Nothing in here is tied to one stack. For robots, use the sibling collection [claude-robotics-skills](https://github.com/joey114132/claude-robotics-skills).

## Install

Inside Claude Code:

```
/plugin marketplace add joey114132/claude-agent-teams
/plugin install agent-teams@claude-agent-teams
```

The plugin name is `agent-teams`, so its agents resolve as `agent-teams:<name>` and its skills as `agent-teams:<skill>`.

## The teams

One agent is the right answer for most tasks. Each team skill starts by deciding whether a team is worth its cost and says so before spawning anything.

| Team (skill) | Shape | Why that shape |
|---|---|---|
| `defect-hunt-until-dry` | Loop until dry: hunters per module and lens, a dedupe barrier in code, one blind skeptic per new finding, stop after two dry rounds, then a critic | The number of defects is unknown. Letting the count of new confirmed findings decide when to stop beats a fixed fan-out that either quits early or wastes tokens. |
| `hypothesis-duel` | Fan-out of one investigator per hypothesis, a barrier, blind cross-examiners, then a chain: failing repro test, fix in a worktree, critic | A single agent anchors on the first plausible cause. Separate contexts that must name a falsifiable prediction, and a separate agent that tries to kill each one, stop that. |
| `design-panel` | Fan-out of independent proposers, a barrier, blind jurors scoring anonymised and reordered proposals, a spread check in code, a scribe, a critic | Proposers must not see each other or they anchor. Scoring is the one place every proposal has to be visible at once. The result is an ADR, so the reasons outlive the session. |
| `incident-timeline-postmortem` | Fan-out per evidence source, blind verification per event, a barrier, a causal chain from verified events only, a refuter per link, a blameless critic | Sources are independent, so collection runs in parallel. Verification is blind and per event so a fabricated timeline line is caught. The analyst needs the whole verified timeline, which is the barrier. |
| `spec-mutation-tests` | Pipeline per requirement (write tests and propose mutants together, then run), survivors fed back up to three rounds, one final barrier for the judge and critic | Requirements are independent, so each streams through without waiting. The grader is the test runner: a mutant dies or survives, and no model opinion decides that. |
| `worktree-migration` | Planner, waves built by code from dependencies, per item a worker in its own git worktree then a deterministic gate then a blind reviewer, a barrier only between waves | Items inside a wave are independent. A passing branch is only believed after a build and test gate that was first shown to fail on a planted broken worktree. It never merges. |

Every team that verifies plants a canary, a known-false finding, and stops with `canary_failed` if the verifier confirms it. A run that cannot show its checkers can say no returns no result.

## The agents

Tools are the least that role needs. Critics, verifiers and judges cannot edit or run anything. Only the roles that produce files get Write or Edit. Bash goes to the roles that must run a command: build and test gates, mutation runs, and the investigators and collectors that run read-only experiments.

| Agent | Team | Tools |
|---|---|---|
| `defect-hunter` | defect-hunt-until-dry | Read, Grep, Glob |
| `defect-skeptic` | defect-hunt-until-dry | Read, Grep, Glob |
| `guard-finder` | defect-hunt-until-dry | Read, Grep, Glob |
| `hunt-report-critic` | defect-hunt-until-dry | Read, Grep, Glob |
| `bug-hypothesis-investigator` | hypothesis-duel | Read, Grep, Glob, Bash |
| `hypothesis-cross-examiner` | hypothesis-duel | Read, Grep, Glob |
| `repro-test-writer` | hypothesis-duel | Read, Write, Bash |
| `duel-fix-builder` | hypothesis-duel | Read, Edit, Write, Bash |
| `root-cause-critic` | hypothesis-duel | Read, Grep, Glob |
| `design-proposer` | design-panel | Read, Grep, Glob |
| `design-juror` | design-panel | Read, Grep, Glob |
| `adr-scribe` | design-panel | Read, Write |
| `adr-critic` | design-panel | Read, Grep, Glob |
| `timeline-evidence-collector` | incident-timeline-postmortem | Read, Grep, Glob, Bash |
| `timeline-event-verifier` | incident-timeline-postmortem | Read, Grep, Glob |
| `causal-chain-analyst` | incident-timeline-postmortem | Read, Grep, Glob |
| `alternative-cause-refuter` | incident-timeline-postmortem | Read, Grep, Glob |
| `blameless-critic` | incident-timeline-postmortem | Read, Grep, Glob |
| `spec-requirement-extractor` | spec-mutation-tests | Read, Grep, Glob |
| `spec-test-writer` | spec-mutation-tests | Read, Write, Edit, Bash |
| `mutant-proposer` | spec-mutation-tests | Read, Grep, Glob |
| `mutation-runner` | spec-mutation-tests | Bash |
| `equivalent-mutant-judge` | spec-mutation-tests | Read, Grep, Glob |
| `test-suite-critic` | spec-mutation-tests | Read, Grep, Glob |
| `migration-planner` | worktree-migration | Read, Grep, Glob |
| `migration-worker` | worktree-migration | Read, Edit, Write, Bash |
| `migration-gate-runner` | worktree-migration | Bash |
| `migration-reviewer` | worktree-migration | Read, Grep, Glob |

## Running a workflow

You normally just describe the job. The matching skill loads, checks that a team is warranted, collects what the run needs (paths, records, commands) and starts the Workflow. To run one yourself, call the Workflow tool with the script from this plugin and an object of args:

```
Workflow scriptPath: ${CLAUDE_SKILL_DIR}/../../workflows/defect-hunt-until-dry.js
args: { root, modules, records, lenses? }
```

`agentPrefix` goes in front of every agent name the script spawns. It defaults to `agent-teams:`, which is right for a plugin install. If you installed the agent files bare (symlinked into `~/.claude/agents`, or loaded with `--plugin-dir`), pass `agentPrefix: ""`.

Things every script guarantees:

- Args may be an object or a JSON string. Missing input returns `{error}` and never an empty "clean" result.
- Caller values can lower a cap and never raise it. A value below a minimum is clamped up to it and reported, and `worktree-migration` rejects an unreadable limit as an error instead of silently using the maximum.
- A script has no clock, so wall time is bounded only by a timeout you put on the call, for example `timeout 3600` around `claude -p`.
- Anything dropped by a cap is reported both through `log()` and in the return value (`notChecked`, `dropped`, `cells_not_run`). A missing list means the run was partial, not clean.
- The scripts never merge into your branch, push, publish or delete anything of yours. They leave drafts, per-item branches and reports for you to act on.

## Architecture rules

The same rules govern every team here, and new teams must follow them.

The shape follows the dependency. A later stage reads an earlier stage's output only when there is a real edge, and independent work runs in parallel. The default is a pipeline where each item streams through its own stages. A barrier is used only when a stage genuinely needs all earlier results, such as a dedupe over every finding or a score table over every proposal, and the script says why in a comment. Wiring such as dedupe, filter, sort and arithmetic is plain code, never an agent, because agents invent numbers.

Roles are an orchestrator, specialists and a critic. The orchestrator plans and assembles but does not do the deep reading. Specialists each do one narrow job with the least power that job needs. A critic reviews against a written standard and returns PASS or a concrete list of failures. Critic loops stop after three rounds and return the best draft with its open objections attached, never looping until agreement.

Verification is blind. A verifier is not told which node produced a finding. A team that verifies plants one canary and fails loudly if the canary is confirmed, because a checker that has never been seen to say no tells you nothing.

Nodes do not know project history, so any node that judges is told which decision records to read: ADRs, intent files, troubleshooting notes. Without that, a team reopens a question the project already closed.

Caps and limits are in code. The number of agents, rounds and retries is fixed before launch and enforced by the script, not requested of the agents.

## Evaluating routing

`evals/route-*` holds routing cases for `claude plugin eval`. Each team has a case where its skill must fire and, for the teams that are easily confused, a case where it must not. Dated results are in [EVAL.md](EVAL.md).

```
claude plugin eval . --no-publish --tag routing --ablation none --runs 2 --case 'route-design-panel'
```

## Third-party notices

This repository is MIT licensed (see [LICENSE](LICENSE)). It contains no copied third-party text or code, and no file carries an `Adapted from` line, because nothing was adapted. The designs reimplement ideas from the sources below, which are cited where each idea is used. For the sources that are not MIT, only the idea was taken, and nothing from them is reproduced.

| Source | License | What the idea was |
|---|---|---|
| [gotalab/cc-sdd](https://github.com/gotalab/cc-sdd) | MIT | Boundary and Depends annotations, dependency-wave batching, capped retries then BLOCKED |
| [maddhruv/absolute](https://github.com/maddhruv/absolute) | MIT | Start from green, one concern per wave, never silence a check, never auto-commit, repeat runs to expose flakiness |
| [shinpr/claude-code-workflows](https://github.com/shinpr/claude-code-workflows) | MIT | Verify each task before commit, return rejections to the owner |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT | A fresh-context reviewer per claim, the "prove it" test pattern |
| [wei18/Upkeep](https://github.com/wei18/Upkeep) | MIT | Discovery, parallel focused reviewers, synthesis; output-only audit; malformed reviewer output degrades to failed |
| [mattpocock/skills](https://github.com/mattpocock/skills) | MIT | Decision records as input; build a pass/fail signal first, rank hypotheses, then fix |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/main/engineering) | Apache-2.0 | ADR draft and evaluate modes; the `incident-response` checklist this plugin improves on |
| [anthropics/claude-code](https://github.com/anthropics/claude-code/tree/main/plugins/code-review) code-review plugin | All rights reserved | One validation agent per flagged issue and a confidence bar. Pattern only, wording is original |
| [trailofbits/skills](https://github.com/trailofbits/skills/tree/main/plugins/spec-to-code-compliance) `spec-to-code-compliance` | CC BY-SA 4.0 | Per-requirement fan-out with structured records. Idea only, no text or code copied |
| Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Published article | Parallelization by voting, the evaluator-optimizer loop |
| Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Published article | Effort scaling, verification and citation as separate agents |
| Anthropic, [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams#investigate-with-competing-hypotheses) and [sub-agents](https://code.claude.com/docs/en/sub-agents) docs | Documentation | Competing hypotheses, worktree isolation and limits |
| [Multiagent Debate](https://arxiv.org/abs/2305.14325), [Self-Consistency](https://arxiv.org/abs/2203.11171), [Reflexion](https://arxiv.org/abs/2303.11366) | Papers | Rejecting judge-free consensus, preferring rubric scores over free-text votes, retries that need an external feedback signal |

## License

MIT. See [LICENSE](LICENSE).
