---
name: design-panel
description: "Use when a wide, expensive-to-reverse design decision has several plausible answers and the choice must hold up: storage engine, service boundary, sync versus async, build versus buy, public API shape, or 'we must choose between Postgres LISTEN/NOTIFY and Kafka'. Fans out up to five independent proposers under fixed lenses, has three blind jurors score the anonymised, reordered proposals on a rubric (every score cites file:line or a decision record), plants one known-bad proposal to prove the jurors can reject, checks the spread in code, then writes the result as an ADR that a read-only critic checks (three rounds at most). Returns 'no clear winner' with both finalists and the dissent instead of a blend. Needs hard constraints and decision-record paths. Not for an obvious answer, an easily reversible choice (just pick), pure taste, renaming or small refactors, or when no constraints or records can be supplied."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Design Panel

Act as the orchestrator of a design panel: you frame the decision, delegate, and report. You do not propose or score designs yourself. The team ends in an Architecture Decision Record, so the choice and its reasons outlive the session.

The team lives in four agents (`agents/design-proposer.md`, `design-juror.md`, `adr-scribe.md`, `adr-critic.md`) and `workflows/design-panel.js`, which does all the wiring. This skill owns when to convene the panel and how far to believe its result.

## The shape and why

Fan-out of N independent proposers, then one barrier, then blind scoring by M jurors, a spread check, one scribe, and a critic loop.

- Proposers see nothing of each other. If they did, the answer would anchor on the first idea.
- Scoring is the only real barrier: a juror has to see every proposal to rank them, and the winner is unknown until all scores are in.
- Code strips authorship, assigns letters, and gives each juror its own seeded shuffle of the proposals, which reduces author and position bias (two jurors can still share an order by chance). Averaging, spread and tie detection are code too, because an agent doing arithmetic invents numbers.
- The scribe reads the score table, so that edge is real. The critic reads the scribe's file, so that one is real too.

Existing coverage is thinner. `council` is conversational voices with no scoring, `santa-method` is a two-reviewer pass or fail, and the judge-panel template in graph-engineering is unblind and has no canary and no decision-record input.

## The decision sequence

1. **Does this need a panel?** It costs about 9 agent calls (5 proposers, 1 canary builder, 3 jurors) plus a scribe and a critic per round, 2 to 6 more. Convene it only when the decision is wide, expensive to reverse and has several plausible answers. If the answer is obvious, the choice is cheap to undo, or it is taste, pick and say why. Default: one agent, no panel.
2. **Write the constraints.** Hard constraints only, one per line, each checkable ("must survive a node restart", "no new managed service"). They become C1, C2 and so on, and jurors cite them. With no constraints the jurors have nothing to ground a score in; stop and ask.
3. **List the decision records.** ADRs, `intent.md`, troubleshooting and wiki pages, handoff notes. Agents start cold and a record outranks their opinion, so a record you forget to list is a decision they will quietly reopen. If the records already rejected something, say so; the canary is built from it.
4. **Say the bottleneck.** The fifth proposer optimises for it. Give it as `bottleneck`, or it will name one itself.
5. **Run it.** Workflow with `scriptPath: '${CLAUDE_SKILL_DIR}/../../workflows/design-panel.js'`, `args` as an object `{decision, constraints, records, adrPath, root, bottleneck}`, and a wall-clock timeout on the call (about 20 minutes; a script has no clock, so the cap lives on the call). Add `agentPrefix: ""` when the agents are installed bare (symlinks or `--plugin-dir`); the default `agent-teams:` fits a plugin install. If Workflow is unavailable, send five `design-proposer` calls in one message, strip their lenses yourself, and give three `design-juror` calls each a different ordering that includes one planted bad proposal; do the averaging by hand and say so.
6. **Read the status first.** `canary_failed` (a juror did not flag it, it beat the median, or fewer than two jurors gave it a valid score) means discard everything: the jurors are not calibrated and no ADR was written. `no_clear_winner` returns both finalists with per-juror cites; show the user the dissent and let them choose. `no_viable_design` means every proposal was disqualified or had too few valid scores. `adr_written` or `adr_open_objections` carries the ADR path.
7. **Finish the ADR files.** The workflow writes one draft per round (`<adrPath minus .md>.r1.md`, `.r2.md`, ...) and returns the best one in `adr.path`. Move that draft to `adrPath`, and ask before deleting the others. A rerun with the same `adrPath` overwrites the earlier `.rN.md` drafts, so move or rename them first. Report `adr.open_objections` verbatim when the critic never passed.

## Roles and caps

| Role | Does | Tools | Cap |
|---|---|---|---|
| Orchestrator (you) | frames the decision, reads the status, reports | read | 1 |
| design-proposer | one design under one lens: smallest change, most reversible, best operability, buy-not-build, the stated bottleneck | read, search | 5, plus 1 canary builder |
| design-juror | scores each anonymised proposal 0-5 on five criteria, each with a cite; lists hard-constraint violations separately | read, search | 3 |
| adr-scribe | writes the ADR from the score table; may not add options or change scores | read, write | 1 per round |
| adr-critic | PASS or a failure list; read-only | read, search | 1 per round, 3 rounds |

The rubric is correctness against constraints, reversibility, operability, fit with existing code, and blast radius. Code computes the rest. If the top two means are within 0.5 point, or the leader's juror spread is above 1.5, the status is `no_clear_winner`. A proposal flagged for a hard-constraint violation or for re-proposing a rejected alternative by a majority of jurors is disqualified; a minority flag is kept and goes into the ADR as open dissent. Clamped caps are reported in `caps_applied`.

## Gotchas

- **The panel is only as good as the records and constraints you give it.** Jurors cannot invent a constraint, and a proposer that was never told a decision was rejected will propose it again. Spend your effort on steps 2 and 3, not on the run.
- **The canary is the calibration, not decoration.** One proposal built from an alternative the records already rejected (or one that breaks a stated constraint) is mixed in. Every juror must flag it and its mean must not beat the median. If not, the run stops with `canary_failed` and no ADR. Do not report the scores anyway "for reference"; unflagged canaries mean the jurors rubber-stamp.
- **Anonymity leaks through prose.** Code removes lens and author, but a proposal that says "the smallest possible change" gives itself away. The proposer prompt forbids naming the lens; if a juror's rationale still guesses authorship, treat that juror's scores as weaker evidence.
- **Same-model jurors share blind spots.** Three jurors that agree is not proof the answer is right; it means none of them saw a counterexample. That is why the cheapest test for the riskiest assumption is mandatory in the ADR.
- **A juror's score for a proposal is discarded if any of its five criteria lacks a valid cite, and a cite is only checked for form.** Code accepts a path-like name with a line number (`src/q.py:40`, `docs/adr/0003.md:9`; `12:30` and `host:80` fail) and accepts a constraint id only for `correctness_vs_constraints`. It cannot tell if the line says what the juror claims. A bare `Makefile:12` fails the form check. A discarded score keeps the juror's hard-constraint flags. A proposal with fewer than two valid scores is returned as `underscored` and is not ranked, so a single juror cannot crown it. Read `uncited`, `unscored` and `ignored_labels` in the result. The critic opens a sample of cites; do the same for the winner's.
- **`no_clear_winner` is a result, not a failure.** Do not average the two finalists into a hybrid. A blend satisfies nobody's constraints; take the dissent to the person who owns the decision.
- **The scribe may not fix the numbers.** If the table looks wrong to it, it says so in `notes` and writes from the table anyway. Read `notes` before you accept the ADR.
- **The critic loop is capped at three rounds.** After that you get the best draft (fewest failures, latest on ties) with the open objections attached, and `regressed: true` when a later round was worse. Do not run a fourth round by hand.
- **The team reads and writes documents, not systems.** Proposers cannot benchmark. Anything that needs a measurement (latency, throughput, cost) comes back as a cheapest-test command for the user to run.

## Sources

Ideas reimplemented, none copied. Anthropic, "Building effective agents" (parallelization by voting, evaluator-optimizer): https://www.anthropic.com/engineering/building-effective-agents. Multiagent Debate, used to reject judge-free consensus: https://arxiv.org/abs/2305.14325. Self-Consistency, used to prefer rubric scores over free-text votes: https://arxiv.org/abs/2203.11171. ADR draft and evaluate modes in the engineering architecture skill (Apache-2.0): https://github.com/anthropics/knowledge-work-plugins/tree/main/engineering. Decision records as input so decided questions are not re-litigated, from https://github.com/mattpocock/skills (MIT).
