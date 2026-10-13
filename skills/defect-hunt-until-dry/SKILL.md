---
name: defect-hunt-until-dry
description: "Use when a codebase slice of unknown quality needs a sweep for latent defects whose findings must be trustworthy enough to act on: a pre-release sweep, inherited code, the aftermath of a large merge, or a request to keep hunting until nothing new turns up and to double-check every bug. Fans hunters out across module x lens (correctness, silent failure, concurrency, security boundary, API contract, resource leaks), dedupes each round against everything already seen, has a blind skeptic try to refute every fresh finding, stops after consecutive dry rounds, and has a read-only critic check the ranked report. Not for reviewing a single diff before merge (use code-review), style or lint cleanups, files small enough for one agent to read, code that cannot be opened, or fixing anything."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Defect Hunt Until Dry

Act as the orchestrator of a defect-hunting team: you scope, delegate and assemble, and you do not do the deep reading yourself. This skill owns when a sweep for unknown-count defects is worth a team, how the loop is wired and how many of its findings to believe. `code-review` owns a single diff. `parallel-code-review` is one pass with four lenses and no verification. `graph-engineering` ships the loop-until-dry shape as a bare template. This skill adds the agents, the canary and the critic.

The team is three agents of this plugin, `agents/defect-hunter.md`, `agents/defect-skeptic.md` and `agents/hunt-report-critic.md`, plus `workflows/defect-hunt-until-dry.js`, which wires them.

## How to answer

- Verdict first: how many findings survived verification, how many did not, and whether the run can be trusted (canary status).
- Report every list the workflow returns, not only the good one: `refuted`, `closed_by_record`, `unverified`, `notChecked`, `cells_not_run`. A missing list means the sweep was partial, not clean.
- Quote `file:line` from the findings. Do not restate severities the critic changed without saying so.
- An empty confirmed list is "this sweep found nothing a skeptic could confirm", never "the code is clean".

## The decision sequence

1. **Does this need a team?** Fan out when the slice is many files wide, a finding will be acted on, and the number of defects is unknown. For one or two files, or one diff, one agent reads faster and costs a fraction. Default: one agent. Say which you chose.
2. **Fix the scope.** List the module paths (directories or files, one hunter cell each per lens) and the project's decision records: `intent.md`, ADRs, troubleshooting or handoff notes. Nodes start cold, so a record not listed is a record they will contradict.
3. **Choose the lenses.** Default six: correctness, silent failure and error handling, concurrency and lifetime, security boundary, API contract, resource leaks. Drop lenses that cannot apply (no threads, no untrusted input). Each lens costs one hunter per module per round.
4. **Run it.** Workflow tool, `scriptPath: '${CLAUDE_SKILL_DIR}/../../workflows/defect-hunt-until-dry.js'`, `args` as an object `{root, modules, records, lenses?}`. Optional: `maxRounds` (5), `dryRounds` (2), `maxHunters` (60), `perRound`, `concurrency` (6), `maxVerifyPerRound` (20). Add `agentPrefix: ""` for bare agents (symlinks or `--plugin-dir`); the default `agent-teams:` fits a plugin install. Put a timeout on the Workflow call itself: a script cannot read a clock, so wall time is bounded only by that timeout.
5. **Read the result in this order.** `error` first (`canary_failed`), then `status` (`canary-less` and `uncalibrated` mean every skeptic verdict is reported as `unverified`), then `critic`, then `confirmed`.
6. **Report and stop.** Fixing is a separate step the user approves. Do not start another sweep because the first was thin; change scope or lenses and say why.

## Shape and why

Loop-until-dry. The number of defects is unknown, so a fixed fan-out either stops early or wastes tokens, and a stop rule keyed to new confirmed findings lets the count decide.

Each round: hunters fan out by (module x lens) from a worker pool, then a **barrier** where code dedupes the round's candidates against every finding ever seen, confirmed and refuted alike. The barrier is real: dedupe needs the whole round and the whole seen set, otherwise refuted findings reappear every round and the streak never ends. After it, skeptics fan out one per fresh finding with no further barrier (`pipeline`). A round counts as dry only if every module x lens cell has run at least once, no hunter failed and nothing is waiting for a skeptic. Two dry rounds in a row stop the loop. Then the critic checks the ranked report.

Later rounds pick cells never run first, then cells that already produced a confirmed finding, then the least-run rest.

## Roles and caps

| Role | Does | Tools | Cap (enforced in code) |
|---|---|---|---|
| Orchestrator (you) | scope, records, reading the result | read | 1 |
| defect-hunter | one module x one lens, candidates with verbatim evidence | read, search | 60 calls in total, 6 at a time, 8 candidates each |
| defect-skeptic | blind refutation of one finding | read, search | 1 per finding, 20 per round, plus a canary |
| guard-finder | copies one real guard clause for the canary | read, search | 1 call |
| hunt-report-critic | checks the ranked report, PASS or failure list | read, search | 3 rounds, then the best draft with open objections |

Also capped: 5 rounds, stop after 2 consecutive dry rounds, a token-budget guard. Code does the wiring (dedupe by same file and title similarity of 0.75 or more, or same file and overlapping narrow ranges (15 lines or less, within 2 lines) from the same lens or with some shared title words; severity sort). Every merged-away candidate is logged and returned in `dropped.duplicates` with the finding that absorbed it. Findings the verify cap cut off go to `notChecked`. Findings no skeptic could decide go to `unverified`. Neither enters `confirmed`.

## Canary

The `guard-finder` agent (read-only) greps one real guard clause in the target, and code forges a false finding from it: the value is "unchecked" on the line right after the guard that protects it. The skeptic must return `real: false`. If it confirms the canary the run returns `error: "canary_failed"` and nothing is reported as confirmed. If no guard exists the run is `canary-less`; if the canary skeptic never answers it is `uncalibrated`. Both report results as unverified. `canary_detail` holds the forged claim and the canary skeptic's reason; read it, because code does not check the finder's guard.

## Gotchas

- **Zero refutations is what a rubber stamp looks like.** Skeptics run on the same model family as the hunters. Only a canary refuted in this run says the verdicts mean something. Report `canary` before any count.
- **Refuted findings must stay in the seen set.** Deduping only against confirmed findings makes the same bad candidate come back every round, so the dry streak never starts and the budget burns on repeats.
- **A dry round with a gap is not dry.** If a hunter failed, a skeptic did not answer, a cell never ran, or findings still wait for a skeptic, the round says nothing about coverage. The workflow refuses to count it, so a flaky hunter lengthens the run up to the round cap. Read `cells_not_run`.
- **Title similarity stays inside one file.** A generic title such as "unchecked return value" would otherwise let one refuted finding hide a real one in another module. The cost is that one defect cited at two call sites is verified twice.
- **Hunters see the seen list, skeptics see nothing.** Hunters get earlier titles so they do not repeat them. Skeptics get one finding with no module, lens, round or count, because a verifier that knows who found it anchors on it.
- **Nodes do not know the project's records.** A skeptic that never opened the decision records calls an accepted gap real. List the record paths every time. An open question in a record is not "closed".
- **Severity labels are a first guess.** The hunter proposes, the skeptic can dispute, the critic can correct. `severity_disputed` marks a skeptic who said the label is wrong without naming a better one.
- **An empty result is not a clean bill.** It means this sweep, with these lenses and modules, confirmed nothing. Say which cells never ran.
- **The team reads code; it fixes nothing and runs nothing.** Anything that needs a measurement on a live system goes back to the user as a command.

## Sources

Ideas reimplemented, no text copied: one validation agent per flagged issue and a confidence bar, from the code-review plugin in github.com/anthropics/claude-code (All rights reserved, pattern only); effort scaling and separate verification agents, from anthropic.com/engineering/multi-agent-research-system; discovery, parallel focused reviewers, synthesis, from github.com/wei18/Upkeep (MIT); a fresh-context reviewer for each non-trivial claim, from github.com/addyosmani/agent-skills (MIT).
