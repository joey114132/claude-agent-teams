---
name: route-hypothesis-duel
description: "Single-skill routing: an intermittent defect with three competing theories and logs to look at should fan out into competing hypotheses."
tags: [routing]
expected_outcome: "Routes to hypothesis-duel: the cause is unknown, three credible explanations exist, the failure is observable in logs, and the user wants the real cause rather than the first plausible one."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
Our nightly order-sync job double-charges about one customer in two hundred, never in staging. The logs for the last bad run are in ./logs/sync-2026-10-11.log and the code is in ./src/sync. Three of us have three different theories: the queue wrapper retries after a timeout, the idempotency-key cache is shared across tenants, or the dedupe window is computed in local time. I don't want whichever one sounds right first. Work out which one is the actual cause, show me why the other two are ruled out, and fix it with a test that fails first.
