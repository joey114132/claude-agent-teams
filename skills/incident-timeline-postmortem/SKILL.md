---
name: incident-timeline-postmortem
description: "Use when an incident has ended or been mitigated and retained evidence exists (deploy log, application log, exported git history, alert export, chat export) and the user wants a postmortem whose timeline lines are each cited and checked, whose causes are separated into observed and inferred, and whose draft passes a blameless review: 'reconstruct what happened from these logs', 'write the postmortem with a verified timeline', 'figure out the timeline of last night's outage and what really caused it'. Fans collection out per evidence source, verifies every event blind, attacks every causal link, and loops a read-only critic at most three times. Not for an incident still in progress (mitigate first), for incidents with no retained logs (the report would be fiction), for security incidents that need legal review or chain of custody, or for a generic response checklist (use incident-response)."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Incident Timeline Postmortem

Act as the orchestrator of a postmortem team: you scope, delegate and assemble, and you do not read the logs yourself. The installed `incident-response` skill is a prose checklist for running an incident. This skill is for after it, when evidence has to be turned into a timeline and a cause that survive scrutiny. The team returns a draft to you. Publishing it to a wiki or sending it to anyone is a separate approval from the user.

The team lives in six files of this plugin: five agents (`timeline-evidence-collector`, `timeline-event-verifier`, `causal-chain-analyst`, `alternative-cause-refuter`, `blameless-critic`) and `workflows/incident-timeline-postmortem.js`, which wires them.

## The decision sequence

1. **Does this need a team?** Fan out only when there are two or more evidence sources, or one source too large to read in one pass, or the postmortem will be acted on. One short log and one question is one agent's job. Say which you chose.
2. **Is the evidence there?** Each source must be a readable text file with timestamps. If git history is a repository directory, export it first (`git log --format=fuller --date=iso-strict > file`), because the verifiers have no shell and could not reopen a raw repo. If nothing was retained for the window, stop and say so.
3. **Fix the window and the records.** The window must start before the earliest suspected trigger (a deploy hours earlier is a common one) and end after mitigation, as ISO 8601 with timezone. List the project's decision records: runbooks, earlier postmortems, ADRs, accepted-risk notes. Agents start cold and will call a known risk a surprise otherwise.
4. **Run it.** Workflow with `scriptPath: '${CLAUDE_SKILL_DIR}/../../workflows/incident-timeline-postmortem.js'` and `args` as an object `{sources, window: {start, end}, records, title}` (a JSON string is also parsed). Add `agentPrefix: ""` when the agents are installed bare (symlinks or `--plugin-dir`); the default `agent-teams:` fits a plugin install. Wrap the call in a wall-clock limit such as `timeout 3600`, since the runtime has no clock.
5. **Read the status.** `PASS` means the critic found nothing open. `OPEN_OBJECTIONS` means three rounds ended with objections left, which the result lists beside the best draft. `UNREVIEWED` means the critic never answered. An `error` with `canary_failed` means a verifier or refuter confirmed something planted as false; the run produced no postmortem and none of its verdicts count.
6. **Report.** Give the draft, then separately what was thrown away: rejected events, refuted links, `dropped_links` (links that cited no verified event), failed sources, clock skew and everything in `notChecked`. A missing source means the timeline is partial, not clean.

## Shape and why

Collection fans out, one collector per source (max 8), because sources are independent. The merge, dedupe, time sort, event cap and clock-skew check are code, since they are wiring. Verification fans out per event (max 200), blind: a verifier gets one event and its citation and reopens the file. A barrier follows because the causal analyst reads the whole verified timeline. Then one refuter per causal link (max 12) asks what else explains the effect and what contradicts it. The draft is rendered by code, so every timeline line carries its citation. A read-only critic reviews it at most 3 rounds.

## Roles and caps

| Role | Does | Tools | Cap |
|---|---|---|---|
| Orchestrator (you) | scope, records, assembly | read | 1 |
| Evidence collector | one source into cited events, no causes | read, search, read-only shell | 8, one per source |
| Event verifier | reopens one cited line, CONFIRMED / WRONG_TIME / NOT_IN_SOURCE | read, search | 200 plus 1 canary |
| Causal-chain analyst | chain from verified events only, OBSERVED or INFERRED | read, search | 1, plus revisions |
| Alternative-cause refuter | one link, HOLDS / WEAKENED / REFUTED | read, search | 12 plus 1 canary |
| Blameless critic | PASS or failure list | read, search | 3 rounds |

Everything beyond a cap is reported in `notChecked`, never dropped silently. At most 240 agents run in total.

## Canaries

The code plants a fabricated event (a real file and line, text that is not on it) and a fabricated link (its stated cause postdates its effect). The verifier must not confirm the first and the refuter must return REFUTED for the second. If either fails, the run returns `canary_failed` and no postmortem. A verifier that confirms everything is the usual reason.

## Gotchas

- **Events from a repo directory cannot be verified.** The verifiers are read-only without a shell. Pass an exported text file or the events come back NOT_IN_SOURCE and the timeline loses its commits.
- **Cross-source times lie.** Servers drift and logs use different timezones. The workflow flags an occurrence that two sources stamp more than 120 s apart (`skewSeconds`), but only when collectors gave both the same `correlation_key`. Treat ordering across flagged sources as uncertain, and say so.
- **Window too narrow loses the trigger.** The change that caused an outage often precedes it by hours. Events outside the window are excluded in code and never reach the chain.
- **Timing is not cause.** Most links end up INFERRED, and a refuter that finds a plausible alternative demotes a link to INFERRED. Do not strengthen the wording when you summarize.
- **The critic cannot see people it cannot find.** Names in quotes are removed only if collectors listed them in `names_found`. Read the draft once for names before it leaves.
- **Missing records mean false surprises.** Without the runbook or earlier postmortems, analysts present an accepted risk as a discovery. Pass them in `records`.
- **A clean-looking postmortem from thin evidence is the failure mode.** Check `failed_sources`, `collectors_over_claimed` and the Unknowns section before trusting the shape.
- **The result is a draft.** It goes to the user, who decides what is posted or sent.

## Sources of the pattern

Collect, then cite, then verify in a separate agent: https://www.anthropic.com/engineering/multi-agent-research-system (citation pass as its own agent, compress findings before returning). Evaluator-optimizer critic loop: https://www.anthropic.com/engineering/building-effective-agents. Output-only audit with no presumed ground truth, and malformed reviewer output degrading to failed rather than crashing: https://github.com/wei18/Upkeep. Baseline checklist this improves on: the `incident-response` skill in https://github.com/anthropics/knowledge-work-plugins/tree/main/engineering.
