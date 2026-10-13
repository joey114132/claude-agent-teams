---
name: route-design-panel
description: "Single-skill routing: a wide, expensive-to-reverse infrastructure choice with constraints and decision records should convene the design panel."
tags: [routing]
expected_outcome: "Routes to design-panel: an architecture choice between Postgres LISTEN/NOTIFY and Kafka with hard constraints and ADRs to respect is a wide, costly-to-reverse decision that needs independent proposals, blind scoring and an ADR."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
We must choose between Postgres LISTEN/NOTIFY and Kafka for the event bus between our order service and the fulfilment services. It is hard to undo once other teams build on it. Hard constraints: it has to survive a node restart without losing events, we cannot add a new managed service, and the ops team is two people. We already have ADRs in docs/adr/ and an intent.md that rejected a bespoke broker earlier. Run a proper comparison and leave us with a decision record we can defend.
