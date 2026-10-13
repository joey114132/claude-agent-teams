---
name: route-design-panel-rename
description: "Negative routing: renaming a variable is not a design decision and must not convene the design panel."
tags: [routing]
expected_outcome: "Does not fire design-panel: a rename is trivially reversible and has an obvious answer."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
Rename this variable from `usr_cnt` to `user_count` in a small Python helper and tell me which lines change.
