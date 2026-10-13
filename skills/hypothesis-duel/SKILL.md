---
name: hypothesis-duel
description: "Use when a defect has an unknown cause, at least two credible explanations and something observable (a failing test, a log, a stack trace, flaky behaviour), and the first plausible cause must not simply win: 'it fails one run in fifty and we have three theories', 'the team is split between a retry bug, a cache bug and a timezone bug', 'find the real root cause, not the first one that fits'. Runs one investigator per hypothesis, has blind cross-examiners try to kill each one, writes a failing repro test for the survivor, then fixes it in a worktree under a read-only critic and leaves a table of why every other cause was ruled out. Not for a bug with an obvious stack trace and one cause (a single debugger is cheaper), a finished outage whose timeline must be reconstructed from retained logs (use incident-timeline-postmortem), an open-ended sweep for unknown defects across modules (use defect-hunt-until-dry), anything that needs a human at hardware, production changes, or robot stacks (use robot-team)."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Hypothesis Duel

Act as the orchestrator of a small debugging team: you scope, delegate and assemble, and you do not do the deep reading yourself. The failure this team exists to prevent is anchoring: a single agent that finds a plausible cause stops there. Here each hypothesis gets its own context and must name an observation that would prove it wrong, and a separate agent then tries to kill it.

The team is five agents and one workflow: `agents/bug-hypothesis-investigator.md`, `agents/hypothesis-cross-examiner.md`, `agents/repro-test-writer.md`, `agents/duel-fix-builder.md`, `agents/root-cause-critic.md` and `workflows/hypothesis-duel.js`.

## The shape, and why

Fan out one investigator per hypothesis, then a **barrier**, then one cross-examiner per hypothesis, then a plain chain. The barrier is real: a cross-examiner attacks a hypothesis with the other hypotheses' evidence, so all cases must exist first. After it, survivors are ranked in code, one failing repro test is written, one builder fixes it in a worktree, and a read-only critic reviews, three rounds at most. The fix stage is a chain because it reads exactly one survivor.

## The decision sequence

1. **Does this need a duel?** Use it when the cause is unknown, at least two explanations are credible and the defect can be observed. With one obvious cause and a stack trace pointing at it, a single agent finishes sooner at a fraction of the cost. Say which you chose.
2. **Collect the observable.** A repro command that is safe to run, or logs and excerpts. With neither, nothing can be falsified, and the workflow returns an error instead of guessing.
3. **List the decision records.** Troubleshooting notes, ADRs, intent files, handoff notes: their paths. Nodes start cold and will re-propose a cause a record already rejected unless told to read them.
4. **Hypotheses.** Pass up to 5 distinct claims, each optionally with a suspect location. With fewer than two the workflow has an investigator propose them. Either way it plants one decoy.
5. **Run it.** Workflow tool, `scriptPath: '${CLAUDE_SKILL_DIR}/../../workflows/hypothesis-duel.js'`, `args` an object `{symptom, root, repro, logs, records, hypotheses}` (a JSON string is also parsed). Add `agentPrefix: ""` when the agents are installed bare (symlinks or `--plugin-dir`); the default `agent-teams:` fits a plugin install. Launch from inside the repository and wrap long runs in `timeout`, because the runtime has no clock. If Workflow is unavailable, send the investigators in one message, then the cross-examiners in one message, and do not skip the decoy.
6. **Read the table.** Report the hypothesis table first: hypothesis, prediction, observation, verdict, what decides it. Then the fix, if there is one. The table is the durable output: it records why the other causes were ruled out.
7. **Stop at the caps.** Do not launch a second duel because you dislike the answer. If no cause survived, say `root cause not established`, give the refutation record and the deciding observations, and let the user choose the next experiment.

## Roles and caps

| Role | Does | Tools | Cap |
|---|---|---|---|
| Orchestrator (you) | scope, records, reading the table | read | 1 |
| Investigator | one hypothesis, a falsifiable prediction, a read-only experiment, verbatim output | read, search, shell | 5 hypotheses plus 1 decoy; 12 shell commands each |
| Cross-examiner | strongest alternative explanation of the same evidence; SURVIVES, REFUTED or UNDERDETERMINED | read, search | 1 round, plus 1 re-investigation round for UNDERDETERMINED |
| Repro test writer | one new failing test, shown failing for the right reason | read, write, shell | 2 tries, worktree |
| Fix builder | smallest change that passes the test without weakening any test | read, edit, write, shell | 2 retries, worktree |
| Critic | PASS or a failure list: cause or symptom, sibling callers, loosened assertions | read, search | 3 rounds |

An UNDERDETERMINED cause is never fixed. The workflow also stops with `canary_failed` when a decoy survives, and with `root_cause_not_established` when nothing does.

## What you get back

`status` is one of `fixed`, `not_fixed_*` (the best draft plus its open objections), `root_cause_not_established`, `repro_not_established`, `cause_established_fix_skipped` or an `error`. Alongside it come `table` (markdown), `hypotheses` (full text), `canary`, `dropped` (hypotheses over the cap and evidence clipped to prompt limits), `cap_violations`, `failed_stages` and `warnings`. The fix lives only in a builder worktree. The user reads the diff and merges it; the team never pushes.

## Gotchas

- **A decoy that survives means every verdict is void.** The workflow plants one hypothesis that a fact in the evidence already rules out, worded like the real ones, at a position that depends on the symptom text. If the cross-examiner lets it SURVIVE the run returns `canary_failed` and ships nothing. The canary reads the examiner's own verdict, not the one after the workflow's consistency downgrades, so an investigator that honestly labels the decoy `contradicts` cannot hide a rubber stamp. A decoy that comes back UNDERDETERMINED or never returns is reported as a warning, not as calibration.
- **Zero refutations is what a rubber stamp looks like.** If every real hypothesis also SURVIVES, say the examiners may have under-attacked rather than that the bug has many causes. Cross-examiners default away from SURVIVES, and unlike the investigators they pin no model, so under a stronger session model they are a different model from the investigators and less likely to share their blind spots.
- **Each investigator must try to break its own hypothesis.** A prediction that no observation could contradict is not a test. If a case has no `falsifier`, or the experiment could only come out one way, treat it as inconclusive.
- **SURVIVES is conservative.** A SURVIVES the investigator's own observation contradicted, or one that still names a `strong` alternative, is downgraded to UNDERDETERMINED and gets the one re-investigation round. The fix builder is also told which sibling hypotheses are undecided, so it does not build on them being false.
- **Caps clamp, they never raise.** A caller cap below its minimum runs at the minimum (`maxRounds: 0` runs 1 round), a non-integer runs at the ceiling, and both are listed in `warnings`.
- **Isolation can fail silently.** If the test writer or the builder reports no absolute worktree path, or the original checkout's path, the run stops with an `isolation` message and a warning to run `git status` in the repository, because that agent may have edited the real checkout.
- **Caps are checked, not enforced inside a running agent.** The shell-command cap is a prompt rule plus an after-the-fact count: an overrun is kept as evidence and listed in `cap_violations`. Agent counts, rounds and retries are real code limits. Wall clock belongs to the caller.
- **Nodes do not know the project's history.** Without decision records an investigator will cheerfully revive a cause the team rejected last month. Give paths; do not paraphrase them.
- **The fix may never weaken a test.** The workflow rejects a builder diff that removes or changes a test line, adds a skip or xfail marker, or alters a line of the repro test. A fix that needs one of those is a symptom patch; the critic will also hunt for sibling callers still exposed.
- **Several survivors are not several fixes.** The top-ranked survivor is repaired and the others are listed. If the repro passes but the symptom remains, the next duel starts from the remaining survivors.
- **This team never touches production or hardware.** Anything that needs a human at a machine, a deploy or a shared service goes back to the user as a command to run. Robot stacks should use `robot-team`, which knows about shared hardware.

## Sources

Ideas reimplemented, none copied. One investigator per competing hypothesis, each also trying to disprove the others, against the anchoring of a single agent, as in the "Investigate with competing hypotheses" use case of Claude Code agent teams: https://code.claude.com/docs/en/agent-teams#investigate-with-competing-hypotheses. Fan-out, barrier, and the evaluator-optimizer loop for the fix stage: Anthropic, "Building effective agents": https://www.anthropic.com/engineering/building-effective-agents. Cross-examination by an independent agent instead of self-agreement: Multiagent Debate, https://arxiv.org/abs/2305.14325. Build a pass/fail signal first, rank hypotheses, then fix against the signal, from the diagnosing-bugs skill in https://github.com/mattpocock/skills (MIT; the pattern only, no text taken, so no third-party notice entry).
