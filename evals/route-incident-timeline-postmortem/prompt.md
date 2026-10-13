---
name: route-incident-timeline-postmortem
description: "Single-skill routing: a finished outage with retained logs, a request for a cited timeline and a blameless postmortem."
tags: [routing]
expected_outcome: "Routes to incident-timeline-postmortem: reconstructing an ended incident from several retained evidence sources into a verified, cited timeline with refuted causes is its job, not a generic incident-response checklist."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
Last night's checkout outage is over and mitigated. I have the deploy log, the application log, a text export of git log, the PagerDuty alert export and the Slack incident channel export, all under /var/incident-4471/. Reconstruct what happened minute by minute, with every timeline line tied to the log line or message it came from, tell me which causes you can actually show versus only suspect, and give me a blameless postmortem draft I can review tomorrow.
