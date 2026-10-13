---
name: route-hypothesis-duel-stacktrace
description: "Negative routing: a crash with a stack trace that points at one line and one obvious cause needs a plain debugger, not a duel between hypotheses."
tags: [routing]
expected_outcome: "Does not fire hypothesis-duel: there is one cause, the trace names it, and a single agent fixes it faster and cheaper than an investigator per theory."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
My script crashes on startup with this trace and I think the cause is obvious, but please fix it:

Traceback (most recent call last):
  File "./tools/export.py", line 41, in <module>
    rows = load_rows(sys.argv[1])
  File "./tools/export.py", line 17, in load_rows
    return [r.split(",")[3] for r in open(path)]
IndexError: list index out of range

It happens with any input that has a line with fewer than four columns. Just make load_rows skip short lines.
