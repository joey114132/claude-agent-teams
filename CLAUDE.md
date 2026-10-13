# claude-agent-teams

A Claude Code plugin of general-purpose agents, team skills and Workflow scripts. The point is architecture. Each team has a stated shape and a reason for it. Each role has the least power it needs. Every team whose output reaches a person has a read-only critic. Caps and limits are in code, not in prompts. The robotics counterpart is github.com/joey114132/claude-robotics-skills.

## Layout

- `.claude-plugin/plugin.json`, `marketplace.json`: the plugin manifests. The plugin name is `agent-teams`, so agents resolve as `agent-teams:<name>`.
- `agents/<name>.md`: frontmatter `name`, a `description` written as a "Use when" routing rule, least-power `tools`, and `model` only when it matters.
- `skills/<name>/SKILL.md`: one team skill per team. It says when to fan out and when one agent is enough, the shape, the roles, the caps, and how to run the workflow (Workflow `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/<file>.js`, with an `agentPrefix` arg defaulting to `'agent-teams:'` and `''` for symlink installs), and has 5+ Gotchas.
- `workflows/<name>.js`: Workflow scripts. Plain JS, `export const meta` as a pure literal, and no `Date.now` or `Math.random`. String args are parsed. Missing input returns `{error}`, never an empty "clean" result. Everything dropped by a cap is reported through `log()` and in the return value.
- `evals/route-<name>/`: `claude plugin eval` routing cases (prompt.md plus graders/, same format as claude-robotics-skills).
- `intent.md`: why the repo exists, what is out of scope, and invariants.

## Rules

- English only, including commit messages. No Co-Authored-By trailer.
- Shape follows the dependency. A later stage reads an earlier stage's output only when there is a real edge. Default to `pipeline()`. Use a barrier only when a stage needs all of the earlier results, and say why in a comment. Wiring (dedupe, filter, sort) is code, not an agent.
- Roles: an orchestrator, specialists and a critic. A critic is read-only and returns PASS or a failure list. Critic loops stop after 3 rounds and return the best draft with its open objections.
- Verification is blind. A verifier does not see which node produced a finding. A team that verifies plants one canary (a known-false finding) and fails loudly if the canary is confirmed.
- Nodes do not know project history. Any node that judges must be told which decision records to read.
- Material adapted from elsewhere keeps an `Adapted from <url> (<license>)` line and is listed in README's third-party notice. MIT-compatible licenses only. Otherwise reimplement the idea and cite it.
- No duplicates. Before adding an agent, check that nothing in this repo or in claude-robotics-skills already does the job.
- Verify before shipping. Run `node --check` on a wrapped `.mjs` copy of each workflow plus a stubbed dry run, then `claude plugin validate .`, then the routing evals for the new cases.
