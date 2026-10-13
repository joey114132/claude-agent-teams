---
name: route-worktree-migration
description: "Routing: a mechanical API migration across about thirty modules of a repo with a green build, wanting one passing branch per module and nothing merged (worktree-migration) versus a live database schema migration or a single review."
tags: [routing]
expected_outcome: "Expected worktree-migration. The user wants one mechanical rename applied across roughly thirty modules of a TypeScript monorepo whose build and tests are green, each module changed on its own branch in isolation, with every branch checked by the build and tests and by a reviewer, and nothing merged. That is a dependency-wave migration with a gate. No database or production data is involved, and it is not a request to review an existing diff."
max_turns: 3
timeout_seconds: 180
allowed_tools: [Read, Grep, Glob, Skill]
---
We're moving our monorepo off the old `HttpClient.request(url, opts)` call to the new `http.send({ url, ...opts })` API. It's the same mechanical edit in about 30 packages under `packages/`, and some packages import helpers from others, so the order matters. `pnpm build` and `pnpm test` are green on main right now. I want each package migrated on its own branch, in isolation, checked by the real build and tests before I see it, and I don't want anything merged or pushed for me. Nobody is allowed to silence a failing check to get green. The ADRs are under `docs/adr/`. Plan it and run it.
