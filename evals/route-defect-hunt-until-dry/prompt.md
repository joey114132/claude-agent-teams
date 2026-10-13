---
name: route-defect-hunt-until-dry
description: "Collision: an open-ended sweep for latent defects across an inherited codebase, with every finding independently double-checked and the hunt repeated until nothing new turns up (defect-hunt-until-dry) versus a single-diff review before merge (code-review)."
tags: [routing]
expected_outcome: "Expected the defect-hunt-until-dry skill. The user has five inherited modules of unknown quality, wants real bugs only, wants each one independently verified, wants the sweep repeated until a couple of passes in a row find nothing new, and wants nothing fixed. That is a loop-until-dry hunt with blind verification across modules. A single-diff review has no diff here, and a one-pass multi-lens review has no verification or stop rule."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
We inherited a billing service with five modules under /work/billing/src: ingest, ledger, invoicing, notifications and the scheduler. Nobody knows the code and the previous team is gone. Before the release I want a sweep for latent defects: wrong results, swallowed errors, races, anything that touches untrusted input, and leaked handles. Keep hunting until a couple of passes in a row turn up nothing new, and don't hand me a bug unless a second pair of eyes has tried to knock it down. Our past decisions are in /work/billing/docs/decisions and /work/billing/intent.md, so don't re-report things we already accepted. Don't fix anything, just give me the confirmed list ranked by severity and tell me what you couldn't check.
