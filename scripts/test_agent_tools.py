#!/usr/bin/env python3
"""Every plugin agent must declare `tools`, and only the agents below may hold Write, Edit, NotebookEdit or Bash, each only the ones listed.

An agent with no `tools` line inherits everything, so a missing line fails the test too.
WRITERS maps agent -> the write or shell tools its team's SKILL.md says it may hold:
  adr-scribe                 design-panel          "read, write"
  repro-test-writer          hypothesis-duel       "read, write, shell"
  duel-fix-builder           hypothesis-duel       "read, edit, write, shell"
  spec-test-writer           spec-mutation-tests   "read, write, edit, bash (test directory only)"
  mutation-runner            spec-mutation-tests   "bash"
  migration-worker           worktree-migration    "Read, Edit, Write, Bash"
  migration-gate-runner      worktree-migration    "Bash"
  bug-hypothesis-investigator hypothesis-duel      "read, search, shell" (observes only)
  timeline-evidence-collector incident-timeline-postmortem "read, search, read-only shell"
Run: python3 scripts/test_agent_tools.py
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS = sorted((ROOT / "agents").glob("*.md"))
FORBIDDEN = {"Write", "Edit", "NotebookEdit", "Bash"}
WRITERS = {
    "adr-scribe": {"Write"},
    "repro-test-writer": {"Write", "Bash"},
    "duel-fix-builder": {"Edit", "Write", "Bash"},
    "spec-test-writer": {"Write", "Edit", "Bash"},
    "mutation-runner": {"Bash"},
    "migration-worker": {"Edit", "Write", "Bash"},
    "migration-gate-runner": {"Bash"},
    "bug-hypothesis-investigator": {"Bash"},
    "timeline-evidence-collector": {"Bash"},
}


def tools_of(path: Path):
    m = re.search(r"^---\n(.*?)\n---", path.read_text(), re.S)
    line = re.search(r"^tools:\s*(.+)$", m.group(1), re.M) if m else None
    # strip argument lists so Bash(git:*) counts as Bash; split only on commas outside parentheses
    return None if line is None else {t.strip().split("(")[0] for t in re.split(r",(?![^(]*\))", line.group(1))}


def test_every_agent_declares_tools():
    assert AGENTS, "no agents found"
    missing = [p.name for p in AGENTS if tools_of(p) is None]
    assert not missing, f"agents with no tools line: {missing}"


def test_only_listed_writers_hold_write_edit_or_bash():
    unlisted = {p.stem: sorted(tools_of(p) & FORBIDDEN) for p in AGENTS if p.stem not in WRITERS and tools_of(p) & FORBIDDEN}
    assert not unlisted, f"read-only agents holding write or shell tools: {unlisted}"


def test_writers_hold_no_more_than_their_skill_allows():
    over = {p.stem: sorted((tools_of(p) & FORBIDDEN) - WRITERS[p.stem]) for p in AGENTS if p.stem in WRITERS and (tools_of(p) & FORBIDDEN) - WRITERS[p.stem]}
    assert not over, f"writers holding more than the allow-list gives them: {over}"


def test_allow_list_has_no_stale_names():
    stale = sorted(set(WRITERS) - {p.stem for p in AGENTS})
    assert not stale, f"allow-list names with no agents/<name>.md: {stale}"


def test_every_critic_is_read_only():
    bad = {p.stem: sorted(tools_of(p) & FORBIDDEN) for p in AGENTS if re.search(r"critic|juror|skeptic|judge|reviewer|refuter|verifier|examiner", p.stem) and tools_of(p) & FORBIDDEN}
    assert not bad, f"critic-like agents holding write or shell tools: {bad}"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"{name}: ok")
    print("ok")
