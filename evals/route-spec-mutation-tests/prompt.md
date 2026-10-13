---
name: route-spec-mutation-tests
description: "Single-skill routing: tests from a written spec that must be proven able to fail, via mutation testing."
tags: [routing]
expected_outcome: "Routes to spec-mutation-tests: the user wants tests derived from a spec and proof that they would catch a real regression, which is what the mutation gate measures."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
docs/rate-limits.md lists six guarantees for our token-bucket limiter in src/limiter.py (burst size, refill rate, per-key isolation, rejection status, reset after idle, no negative tokens). The suite runs with `pytest -q` and is deterministic. I want tests written from that doc, but I don't trust tests that just pass because the same model wrote them. Write them and show me which guarantees would go unnoticed if someone broke the code, for example with mutants that survive.
