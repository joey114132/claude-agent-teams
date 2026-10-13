---
name: route-hypothesis-duel-vs-postmortem
description: "Collision: reconstructing a finished outage into a cited timeline and postmortem (incident-timeline-postmortem) versus choosing between live theories about an open defect (hypothesis-duel)."
tags: [routing]
expected_outcome: "Routes to incident-timeline-postmortem and not to hypothesis-duel. The incident is over, the logs are retained, and the ask is a cited minute-by-minute timeline and a blameless postmortem. Nothing is being fixed and no theories are being raced."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
CI was red for four hours yesterday and a rollback fixed it. It is resolved. I have the CI job logs, the deploy log, the git log export and the team chat export under /var/ci-incident-88/. I need a minute-by-minute timeline where every line cites the log line or message it came from, a statement of which causes you can show and which are only suspected, and a blameless postmortem draft for the review meeting. No code changes.
