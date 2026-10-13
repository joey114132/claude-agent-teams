---
name: route-hypothesis-duel-vs-hunt
description: "Collision: an open-ended sweep for latent defects with no specific symptom (defect-hunt-until-dry) versus debugging one known symptom with competing theories (hypothesis-duel)."
tags: [routing]
expected_outcome: "Routes to defect-hunt-until-dry and not to hypothesis-duel. There is no observed failure and no list of theories to test, only a request to find whatever is wrong in unfamiliar modules, repeated until a pass finds nothing new."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
We took over a scheduling service with four modules under /work/sched/src: queue, planner, calendar and notifier. Nothing is failing right now, but nobody trusts it. Hunt for real latent bugs in all four, have each one independently double-checked, and keep going until two passes in a row find nothing new. Decisions we already made are in /work/sched/docs/decisions. Report confirmed bugs only, ranked by severity, and do not fix anything.
