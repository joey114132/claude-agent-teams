export const meta = {
  name: 'worktree-migration',
  description: 'Apply one mechanical migration across 5-40 modules: a read-only planner, items grouped into dependency waves by code, then per item a worker in its own git worktree, a deterministic build/test gate with a silence scan and a blind reviewer, behind a canary that proves the gate can fail. Never merges; leaves one passing branch per item',
  phases: [
    { title: 'Baseline', detail: 'build and tests on the untouched checkout must be green' },
    { title: 'Plan', detail: 'migration-planner lists items with Boundary and Depends; code builds the waves' },
    { title: 'Canary', detail: 'a deliberately broken worktree must be rejected by the real gate' },
    { title: 'Migrate', detail: 'waves in order; inside a wave each item streams worker, gate, review' },
    { title: 'Report', detail: 'assembled in code' },
  ],
}

// args: { root: "<repo path>", description: "<migration with before/after examples>", build: "<cmd>", test: "<cmd>",
//         records?: ["<decision record paths>"], maxItems?: n, concurrency?: n, maxRetries?: n, maxRounds?: n,
//         gateTimeoutSec?: n, canary?: {file, append}, prepare?: "<cmd>", agentPrefix?: "agent-teams:" }   (a JSON string is accepted too)
// prepare runs in each fresh worktree before the build (an install, or a symlink to the main checkout's dependencies; the
// original checkout is in $MIGRATION_ROOT). It must leave only git-ignored files. The baseline runs in the checkout as it is.
// Caller limits can lower the caps, never raise them; a limit that is not a positive integer is an error, not the maximum. agentPrefix goes in front of each agent name; the default fits a
// plugin install, pass "" when the agents are installed bare (symlinks into ~/.claude/agents, or --plugin-dir).
// Launch it from inside the repository: the workers' worktrees are cut from the session's working directory.
// The runtime has no clock, so the wall-clock limit belongs to the caller: `timeout 7200 claude -p ...`. Each gate
// command also runs under `timeout <gateTimeoutSec>`.

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) {
    return { error: 'args is a string that is not valid JSON (' + e.message + '); nothing ran' }
  }
}
const isStr = v => typeof v === 'string' && v.trim() !== ''
if (!input || typeof input !== 'object' || !isStr(input.root) || !isStr(input.description) || !isStr(input.build) || !isStr(input.test)) {
  return { error: 'worktree-migration needs args {root, description, build, test, records?, maxItems?, concurrency?, maxRetries?, maxRounds?, gateTimeoutSec?, canary?, prepare?, agentPrefix?}; nothing ran' }
}
const PREFIX = input.agentPrefix !== undefined ? input.agentPrefix : 'agent-teams:'
if (typeof PREFIX !== 'string') return { error: 'agentPrefix must be a string ("" for bare agent names); nothing ran' }
const AGENT = name => PREFIX + name

const root = input.root.trim().replace(/\/+$/, '')
const description = input.description.trim()
const BUILD = input.build.trim()
const TEST = input.test.trim()
const PREPARE = isStr(input.prepare) ? input.prepare.trim() : ''
const records = Array.isArray(input.records) ? input.records.filter(isStr) : []
const RECORDS = records.length ? records.join(', ') : '(none listed: search the repository for ADR, intent, troubleshooting and handoff files and say what you found)'

// Hard ceilings live here, in code. Per item at most 3 attempts x (worker + gate + reviewer) = 9 agents.
const HARD = { items: 40, concurrency: 5, retries: 2, rounds: 3, agents: 380, gateTimeout: 1800, diffChars: 80000 }
const capErrors = []
const cap = (name, v, hard, min) => {
  if (v === undefined || v === null) return hard
  if (!Number.isInteger(v) || v < min) { capErrors.push(`${name} must be an integer >= ${min} (got ${JSON.stringify(v)})`); return hard }
  return Math.min(v, hard)
}
const MAX_ITEMS = cap('maxItems', input.maxItems, HARD.items, 1)
const CONC = cap('concurrency', input.concurrency, HARD.concurrency, 1)
const MAX_RETRIES = cap('maxRetries', input.maxRetries, HARD.retries, 0)
const MAX_ROUNDS = cap('maxRounds', input.maxRounds, HARD.rounds, 1)
const GATE_TIMEOUT = cap('gateTimeoutSec', input.gateTimeoutSec, HARD.gateTimeout, 1)
if (capErrors.length) return { error: 'bad_limits', problems: capErrors, detail: 'a limit that cannot be read would silently become the maximum; fix the args; nothing ran' }
const MIN_BUDGET_PER_WAVE = 150000
log(`caps: items ${MAX_ITEMS}, concurrent worktrees ${CONC}, worker retries ${MAX_RETRIES}, review rounds ${MAX_ROUNDS}, gate timeout ${GATE_TIMEOUT}s, agents ${HARD.agents}`)

let spawned = 0
const failed_stages = []
const dropped = []
const drop = (what, why) => { dropped.push({ what, why }); log(`dropped: ${what} (${why})`) }
const truncated = []   // prompt material cut to a size limit: reported here and in the log, not in dropped (those are items never attempted)
const PREV_DIFF_CHARS = 20000

async function spawn(prompt, opts) {
  if (spawned >= HARD.agents) {
    failed_stages.push({ stage: opts.phase, id: opts.label, why: `agent cap ${HARD.agents} reached` })
    log(`agent cap ${HARD.agents} reached; skipped ${opts.label}`)
    return null
  }
  spawned++
  const out = await agent(prompt, opts)
  if (!out) failed_stages.push({ stage: opts.phase, id: opts.label, why: 'agent returned null (failed or skipped)' })
  return out
}

// Slot limiter: at most CONC items hold a worktree at once. A freed slot is handed straight to the next waiter,
// so `active` never exceeds CONC.
let active = 0
let peak = 0
const waiters = []
const acquire = () => {
  if (active < CONC) { active++; peak = Math.max(peak, active); return Promise.resolve() }
  return new Promise(r => waiters.push(r))
}
const release = () => { const n = waiters.shift(); if (n) n(); else active-- }
const withSlot = async fn => { await acquire(); try { return await fn() } finally { release() } }

// ---------------------------------------------------------------- schemas
const PLAN = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          boundary: { type: 'array', items: { type: 'string' } },
          depends: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['id', 'title', 'files', 'boundary', 'depends', 'risk'],
      },
    },
    unclassified: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
    canary: { type: 'object', properties: { file: { type: 'string' }, append: { type: 'string' }, why: { type: 'string' } }, required: ['file', 'append'] },
    records_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'unclassified', 'canary'],
}

const GATE = {
  type: 'object',
  properties: {
    cwd: { type: 'string' }, head: { type: 'string' }, status_porcelain: { type: 'string' },
    rollback: {
      type: 'object',
      properties: {
        sha: { type: 'string' }, parents: { type: 'integer' }, is_ancestor_of_head: { type: 'boolean' },
        base_is_ancestor: { type: 'boolean' }, deps_are_ancestors: { type: 'boolean' },
      },
    },
    current_branch: { type: 'string' }, branch_head: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string' },
    prepare_exit: { type: 'integer' },
    build_exit: { type: 'integer' }, build_tail: { type: 'string' },
    test_exit: { type: 'integer' }, test_tail: { type: 'string' },
    tests_total: { type: 'integer' },
    failed_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['cwd', 'head', 'status_porcelain', 'build_exit', 'test_exit', 'failed_ids'],
}

const WORK = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'declined'] },
    worktree_path: { type: 'string' }, branch: { type: 'string' },
    rollback_commit: { type: 'string' }, head_commit: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['status', 'notes'],
}

const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' }, line: { type: 'integer' },
          kind: { type: 'string', enum: ['semantic_change', 'behaviour_drift', 'outside_boundary', 'weakened_test', 'record_violation', 'other'] },
          severity: { type: 'string', enum: ['blocker', 'minor'] },
          problem: { type: 'string' }, needs: { type: 'string' },
        },
        required: ['severity', 'problem'],
      },
    },
    files_opened: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'failures'],
}

// ---------------------------------------------------------------- deterministic checks (code, not agents)
const esc = s => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
const globRe = p => (p.endsWith('/')
  ? new RegExp('^' + esc(p))
  : new RegExp('^' + esc(p).replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*') + '$'))
const inBoundary = (path, boundary) => boundary.some(b => globRe(b).test(path))
const pathOk = p => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').includes('..')
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

// Silence scan over a unified diff. Added lines are checked for muted checks; removed versus added assertions are counted;
// deleted test files are listed. A hit fails the item automatically, nobody can argue it away.
const SUPPRESS = [
  [/@ts-(ignore|nocheck|expect-error)/, 'type-check suppression'],
  [/eslint-disable|tslint:disable|#\s*(noqa|pylint:\s*disable)|#\s*type:\s*ignore|\/\/\s*nolint|\/\/\s*NOLINT|#\s*pragma\s+warning\s+disable|@SuppressWarnings|@Suppress\(|#!?\[allow\(/, 'lint or compiler suppression'],
  [/--no-verify/, 'hook bypass'],
  [/pytest\.mark\.(skip|skipif|xfail)|pytest\.(skip|xfail)\(|unittest\.(skip|expectedFailure)|@skip\b/, 'python skip or xfail'],
  [/\b(xit|xdescribe|xtest|fit|fdescribe)\(|\b(it|test|describe)\.(skip|todo|only)\(|\bt\.Skip\(|@(Ignore|Disabled)\b|#\[ignore\]|\[Fact\(Skip|\bXFAIL\b/, 'disabled or focused test'],
  [/\|\|\s*true\b|set\s+\+e\b|continue-on-error|allow_failure|ignore_errors/, 'failure swallowed in a command or CI config'],
  [/assert\s+True\b|assertTrue\(\s*True\s*\)|expect\(\s*true\s*\)|toBeTruthy|toBeDefined|expect\.anything|assert\(\s*true\s*\)|assert_eq!\(\s*true/, 'loosened assertion'],
]
// Assertion lines are counted in test files only. `require` is not an assertion (a CJS to ESM change removes it legitimately).
// Known false positive: folding two expect lines into one still reads as a removal; see the SKILL.md gotcha.
const ASSERT = /\b(assert[A-Za-z_]*|expect|EXPECT_[A-Z_]+|ASSERT_[A-Z_]+)\b/
const TESTISH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.|_test\.|test_[^/]*$/

function scanDiff(diff) {
  const hits = []
  let file = ''
  let removedAsserts = 0
  let addedAsserts = 0
  for (const line of String(diff || '').split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) { file = m[2]; continue }
    if (line.startsWith('deleted file mode') && TESTISH.test(file)) hits.push({ kind: 'deleted_test_file', file, line: line.trim() })
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      for (const [re, what] of SUPPRESS) if (re.test(line)) hits.push({ kind: 'silence', file, what, line: line.slice(0, 160) })
      if (TESTISH.test(file) && ASSERT.test(line)) addedAsserts++
    } else if (line.startsWith('-') && TESTISH.test(file) && ASSERT.test(line)) removedAsserts++
  }
  if (removedAsserts > addedAsserts) hits.push({ kind: 'assertions_removed', file: '(diff)', what: `${removedAsserts} assertion lines removed, ${addedAsserts} added` })
  return hits
}

const diffPaths = diff => {
  const out = new Set()
  for (const line of String(diff || '').split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) { out.add(m[1]); out.add(m[2]) }
  }
  return [...out]
}

// The diff is text the gate-runner copied into JSON, and every code check reads it, so first prove it is whole: each hunk
// must hold exactly the number of lines its header announces. An elided line (a quiet @ts-ignore) breaks the count.
function diffComplete(diff) {
  const lines = String(diff || '').replace(/\n$/, '').split('\n')
  let oldN = 0
  let newN = 0
  for (const line of lines) {
    const h = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/)
    if (oldN <= 0 && newN <= 0) {
      if (h) { oldN = h[1] === undefined ? 1 : +h[1]; newN = h[2] === undefined ? 1 : +h[2] }
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('diff --git ')) return false
    if (line.startsWith('+')) newN--
    else if (line.startsWith('-')) oldN--
    else { oldN--; newN-- }
  }
  return oldN === 0 && newN === 0
}

const intOk = Number.isInteger
// Build/test part of the gate: exit codes are the authority.
function judgeRun(g, baseline, prepared) {
  if (!g) return [{ kind: 'gate_missing', detail: 'the gate-runner returned nothing' }]
  const r = []
  if (prepared && g.prepare_exit !== 0) r.push({ kind: 'prepare', detail: `prepare exit ${g.prepare_exit === undefined ? 'missing' : g.prepare_exit}; a build that fails only because dependencies are missing says nothing about the change` })
  if (!intOk(g.build_exit) || !intOk(g.test_exit)) r.push({ kind: 'gate_incomplete', detail: 'build or test exit code missing' })
  else {
    if (g.build_exit !== 0) r.push({ kind: 'build', detail: `build exit ${g.build_exit}`, tail: g.build_tail || '' })
    if (g.test_exit !== 0) r.push({ kind: 'tests', detail: `test exit ${g.test_exit}`, tail: g.test_tail || '' })
  }
  if ((g.failed_ids || []).length) r.push({ kind: 'failed_tests', detail: g.failed_ids.join(', ') })
  if (baseline && intOk(baseline.tests_total)) {
    if (!intOk(g.tests_total)) r.push({ kind: 'test_count', detail: `baseline ran ${baseline.tests_total} tests, this run reported no count` })
    else if (g.tests_total < baseline.tests_total) r.push({ kind: 'test_count', detail: `${g.tests_total} tests ran, baseline ran ${baseline.tests_total}` })
  }
  return r
}

const fmtReasons = rs => rs.map(x => `- [${x.kind}] ${x.detail || ''}${x.tail ? '\n  output tail: ' + String(x.tail).slice(-1500) : ''}`).join('\n')

// Self-test of the scanner before any agent is paid for: it must flag a muted check and stay quiet on a clean rename.
const BAD_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-f(1)\n+// @ts-ignore\n+g(1)\ndiff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1,1 +1,1 @@\n-expect(f(1)).toBe(2)\n+g(1)\ndiff --git a/src/b.test.ts b/src/b.test.ts\ndeleted file mode 100644\n'
const CLEAN_DIFF = 'diff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1,1 +1,1 @@\n-expect(f(1)).toBe(2)\n+expect(g(1)).toBe(2)\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,1 @@\n-const x = require("x")\n-const y = require("y")\n+import { x, y } from "xy"\n'
if (scanDiff(BAD_DIFF).length < 3 || scanDiff(CLEAN_DIFF).length !== 0 || !diffComplete(BAD_DIFF) || !diffComplete(CLEAN_DIFF) || diffComplete(CLEAN_DIFF.replace('-const y = require("y")\n', ''))) {
  return { error: 'canary_failed', detail: 'the silence scan or the diff completeness check failed its self-test (it must flag a muted check, a removed assertion and a deleted test, pass a clean rename and a require-to-import change, and reject a diff with a line missing); nothing ran' }
}

// ---------------------------------------------------------------- gate prompt
const shq = t => "'" + String(t).replace(/'/g, "'\\''") + "'"
function gatePrompt(o) {
  const L = []
  L.push(o.mode === 'canary'
    ? 'Run the gate in YOUR OWN current directory: it is a scratch worktree. Do not cd anywhere else.'
    : `Run the gate in the directory ${o.dir}. First: cd ${o.dir} && pwd (report it as cwd).`)
  L.push('Report raw results only. Do not fix, retry, edit, commit or explain.', '')
  L.push('Git facts, captured BEFORE building (a build writes files):')
  L.push('1. git rev-parse HEAD  (head)', '2. git status --porcelain  (status_porcelain, verbatim; empty string when clean)')
  if (o.mode === 'item') {
    L.push(`3. Rollback checks, with rollback commit ${o.rollback}:`,
      `   - sha: git rev-parse ${o.rollback}`,
      `   - parents: the number of parents printed by git rev-list --parents -n1 ${o.rollback} (words on that line minus one)`,
      `   - is_ancestor_of_head: git merge-base --is-ancestor ${o.rollback} HEAD (true when exit 0)`,
      `   - base_is_ancestor: git merge-base --is-ancestor ${o.baseHead} ${o.rollback} (true when exit 0)`,
      `   - deps_are_ancestors: true only if for EVERY commit in [${o.depHeads.join(', ')}] git merge-base --is-ancestor <commit> ${o.rollback} exits 0 (true for an empty list)`)
    L.push(`4. files_changed: git -c core.quotepath=off diff --name-only ${o.rollback}`, `5. diff: git -c core.quotepath=off diff ${o.rollback}  (the full text, every hunk, unmodified and never abbreviated)`,
      '6. current_branch: git rev-parse --abbrev-ref HEAD', `7. branch_head: git rev-parse ${o.branch}  (omit if that branch does not exist)`)
  }
  if (o.mode === 'canary') {
    L.push(`3. diff: git -c core.quotepath=off diff ${o.baseHead}  (run AFTER the canary edit below, full text); files_changed: git -c core.quotepath=off diff --name-only ${o.baseHead}`)
    L.push('', `CANARY EDIT. Before building, append exactly this text, unchanged, followed by a newline, to the file ${o.canary.file} in this worktree, and do nothing else to any file:`, '<<<CANARY', o.canary.append, 'CANARY>>>')
  }
  if (PREPARE && o.mode !== 'baseline') {
    L.push('', `PREPARE, after the git facts and the canary edit and before the build: MIGRATION_ROOT=${shq(root)} timeout ${GATE_TIMEOUT} sh -c ${shq(PREPARE)}  -> prepare_exit. It only makes dependencies available in this worktree.`)
  }
  L.push('', `Then, in order, even if an earlier command fails (each wrapped in timeout ${GATE_TIMEOUT}):`,
    `A. build: timeout ${GATE_TIMEOUT} sh -c ${JSON.stringify(BUILD)}  -> build_exit, build_tail (last 40 lines of combined output)`,
    `B. tests: timeout ${GATE_TIMEOUT} sh -c ${JSON.stringify(TEST)}  -> test_exit, test_tail (last 40 lines), tests_total (the count the runner prints, omit if none), failed_ids (ids the runner prints as failed, copied literally)`)
  return L.join('\n')
}

// ---------------------------------------------------------------- Baseline
phase('Baseline')
const baselineRaw = await spawn(
  gatePrompt({ mode: 'baseline', dir: root }),
  { agentType: AGENT('migration-gate-runner'), label: 'gate:baseline', phase: 'Baseline', schema: GATE })
const baselineReasons = judgeRun(baselineRaw, null)
if (baselineReasons.length) {
  log(`baseline is red: ${baselineReasons.map(x => x.kind).join(', ')}`)
  return { error: 'baseline_red', reasons: baselineReasons, detail: 'build and tests must pass before the first change, so there is nothing to compare a migrated item against; nothing was changed', failed_stages }
}
if ((baselineRaw.status_porcelain || '').trim()) {
  return { error: 'baseline_dirty', detail: 'the checkout has uncommitted changes, so the worktrees (cut from HEAD) would not match the baseline: commit or stash them; nothing was changed', status: baselineRaw.status_porcelain }
}
const baseline = baselineRaw
const baseHead = baseline.head
log(`baseline green at ${baseHead}${intOk(baseline.tests_total) ? `, ${baseline.tests_total} tests` : ', no test count reported'}`)

// ---------------------------------------------------------------- Plan
// Sequential on purpose: a red baseline exits before the planner reads the whole repository.
phase('Plan')
const plan = await spawn(
  `Plan this migration. Repository root: ${root}\nBuild: ${BUILD}\nTest: ${TEST}\nDecision records you MUST read before listing items: ${RECORDS}\n\nMigration description with examples:\n${description}`,
  { agentType: AGENT('migration-planner'), label: 'plan', phase: 'Plan', schema: PLAN })
if (!plan) return { error: 'planner failed; nothing was changed', failed_stages }

function validatePlan(p) {
  const problems = []
  const items = p.items
  if (!items.length) return ['the planner returned no items']
  const ids = new Set()
  for (const it of items) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(it.id)) problems.push(`item id "${it.id}" is not a safe branch name`)
    if (ids.has(it.id)) problems.push(`duplicate item id "${it.id}"`)
    ids.add(it.id)
    if (!it.boundary.length || !it.boundary.every(pathOk)) problems.push(`item ${it.id}: boundary must be non-empty repo-relative paths without ".." (got ${JSON.stringify(it.boundary)})`)
    else for (const f of it.files) if (!inBoundary(f, it.boundary)) problems.push(`item ${it.id}: file ${f} is outside its own boundary`)
    for (const d of it.depends) {
      if (d === it.id) problems.push(`item ${it.id} depends on itself`)
      else if (!items.some(x => x.id === d)) problems.push(`item ${it.id} depends on unknown item "${d}"`)
    }
  }
  return problems
}
let problems = validatePlan(plan)

// Waves by Kahn layering: wave n holds the items whose dependencies all sit in waves before n.
const waveOf = new Map()
let waves = []
if (!problems.length) {
  let rest = plan.items.slice()
  while (rest.length) {
    const layer = rest.filter(it => it.depends.every(d => waveOf.has(d)))
    if (!layer.length) { problems.push(`dependency cycle among: ${rest.map(x => x.id).join(', ')}`); break }
    layer.forEach(it => waveOf.set(it.id, waves.length))
    waves.push(layer)
    rest = rest.filter(it => !waveOf.has(it.id))
  }
}
if (!problems.length) {
  // Two items with no dependency path between them are merged by hand side by side, whatever wave they sit in, so they must
  // not edit the same file. An item that depends on another contains it, and may share its boundary.
  const byId = new Map(plan.items.map(it => [it.id, it]))
  const ancestors = id => {
    const seen = new Set()
    const walk = x => { for (const d of byId.get(x).depends) if (!seen.has(d)) { seen.add(d); walk(d) } }
    walk(id)
    return seen
  }
  const anc = new Map(plan.items.map(it => [it.id, ancestors(it.id)]))
  const its = plan.items
  for (let i = 0; i < its.length; i++) for (let j = i + 1; j < its.length; j++) {
    if (anc.get(its[i].id).has(its[j].id) || anc.get(its[j].id).has(its[i].id)) continue
    const clash = its[i].boundary.find(a => its[j].boundary.some(b => a === b || globRe(a).test(b) || globRe(b).test(a)))
    if (clash) problems.push(`items ${its[i].id} (wave ${waveOf.get(its[i].id) + 1}) and ${its[j].id} (wave ${waveOf.get(its[j].id) + 1}) have overlapping boundaries at "${clash}" and no dependency path between them: one must depend on the other`)
  }
}
if (problems.length) {
  log(`plan rejected: ${problems.join('; ')}`)
  return { error: 'plan_invalid', problems, unclassified: plan.unclassified, failed_stages }
}

// Tail cut by topological order: a dependent always sits in a later wave than its dependency, so a cut never leaves an
// item whose dependency was removed.
const RISK = { high: 0, medium: 1, low: 2 }
waves = waves.map(wv => wv.slice().sort((a, b) => RISK[a.risk] - RISK[b.risk]))
const ordered = waves.flat()
const kept = new Set(ordered.slice(0, MAX_ITEMS).map(x => x.id))
for (const it of ordered.slice(MAX_ITEMS)) drop(`item ${it.id} "${it.title}"`, `over the ${MAX_ITEMS}-item cap`)
waves = waves.map(wv => wv.filter(it => kept.has(it.id))).filter(wv => wv.length)
for (const u of plan.unclassified) drop(`module ${u.path}`, `planner could not classify it: ${u.reason}`)
log(`plan: ${kept.size} item(s) in ${waves.length} wave(s): ${waves.map((wv, n) => `w${n + 1}=${wv.length}`).join(' ')}; unclassified ${plan.unclassified.length}`)

// ---------------------------------------------------------------- Canary
phase('Canary')
const canarySpec = input.canary && isStr(input.canary.file) && isStr(input.canary.append) ? input.canary : plan.canary
if (!pathOk(canarySpec.file) || !isStr(canarySpec.append)) {
  return { error: 'canary_failed', detail: `no usable canary edit (file ${JSON.stringify(canarySpec.file)}); pass args.canary {file, append}; no real item was touched`, failed_stages }
}
const canaryRaw = await withSlot(() => spawn(
  gatePrompt({ mode: 'canary', baseHead, canary: canarySpec }),
  { agentType: AGENT('migration-gate-runner'), isolation: 'worktree', label: 'gate:canary', phase: 'Canary', schema: GATE }))
const canaryJudged = judgeRun(canaryRaw, baseline, !!PREPARE)
const canaryRun = canaryJudged.filter(x => x.kind === 'build' || x.kind === 'tests' || x.kind === 'failed_tests')
const canaryScan = canaryRaw ? scanDiff(canaryRaw.diff) : []
const canary = { file: canarySpec.file, rejected_by_run: canaryRun.map(x => x.kind), scan_hits: canaryScan.length, ran: !!canaryRaw }
if (!canaryRaw) {
  return { error: 'canary_failed', detail: 'the canary gate run returned nothing, so it is not proven that the gate can fail; no real item was touched', canary, failed_stages }
}
if (canaryJudged.some(x => x.kind === 'prepare')) {
  return { error: 'canary_failed', detail: `the prepare command failed in the canary worktree (${canaryJudged.find(x => x.kind === 'prepare').detail}); a canary rejected only for missing dependencies proves nothing. Fix args.prepare; no real item was touched.`, canary, failed_stages }
}
if (!canaryRun.length) {
  log('CANARY PASSED THE GATE: the gate is not testing anything; aborting before any real item')
  return { error: 'canary_failed', detail: `a worktree with a deliberate breaking edit to ${canarySpec.file} passed build and tests (build_exit ${canaryRaw.build_exit}, test_exit ${canaryRaw.test_exit}); the gate cannot be trusted, or the canary file is not compiled or tested: pass args.canary {file, append}. No real item was touched.`, canary, failed_stages }
}
if (!canaryRun.some(x => x.kind === 'tests' || x.kind === 'failed_tests')) {
  log('CANARY WAS REJECTED BY THE BUILD ONLY: the test command is not proven able to fail; aborting before any real item')
  return { error: 'canary_failed', detail: `the breaking edit to ${canarySpec.file} failed the build (${canary.rejected_by_run.join(', ')}) but the test command still exited ${canaryRaw.test_exit} with no failing test; a test command that cannot fail (for example "true") would pass every migrated item. Pass args.canary {file, append} for a file the tests load, or fix the test command. No real item was touched.`, canary, failed_stages }
}
log(`canary rejected by the real gate (${canary.rejected_by_run.join(', ')}); build and tests both proven able to fail`)
if (!intOk(baseline.tests_total)) log('warning: the runner printed no test total, so the test-count guard is off for this run')

// ---------------------------------------------------------------- Migrate
phase('Migrate')
const result = new Map() // id -> record
const checkedStatus = id => (result.get(id) || {}).status

function workerPrompt(it, branch, attempt, feedback, prevDiff, depBranches) {
  if (prevDiff.length > PREV_DIFF_CHARS) {
    truncated.push({ what: `previous diff of ${it.id} (attempt ${attempt - 1}) given to attempt ${attempt}`, chars_cut: prevDiff.length - PREV_DIFF_CHARS })
    log(`truncated: previous diff of ${it.id} cut from ${prevDiff.length} to ${PREV_DIFF_CHARS} chars for attempt ${attempt}`)
  }
  return `Apply migration item ${it.id}: ${it.title}\n` +
    `Repository root of the original checkout (do NOT edit there): ${root}\n` +
    `Your branch: ${branch}\nStarting commit you must be on: ${baseHead}\n` +
    `Dependency branches to merge first, in this order, each with git merge --no-ff --no-edit: ${depBranches.length ? depBranches.map(d => `${d.branch} (head ${d.head})`).join(', ') : '(none; your rollback_commit must be exactly ' + baseHead + ')'}\n` +
    `Files you expect to change: ${it.files.join(', ') || '(see the examples)'}\n` +
    `Boundary (you may edit ONLY paths matching these): ${it.boundary.join(', ')}\n` +
    `Build: ${BUILD}\nTest: ${TEST}\n` + (PREPARE ? `Before you build, run once in your worktree (the only install you may run; it must leave only git-ignored files): MIGRATION_ROOT=${shq(root)} sh -c ${shq(PREPARE)}\n` : '') + `Decision records to read first: ${RECORDS}\n` +
    `Attempt ${attempt} of ${1 + MAX_RETRIES}.\n\nMigration description with examples:\n${description}` +
    (feedback ? `\n\nThe previous attempt failed. Failures:\n${feedback}\n\nPrevious diff (reference only; reapply what was right in your fresh worktree):\n${prevDiff.slice(0, PREV_DIFF_CHARS)}` : '')
}

async function runItem(it, wave) {
  const rec = { id: it.id, wave: wave + 1, title: it.title, status: 'blocked', attempts: 0, review_rounds: 0, history: [], branch: null, head: null, rollback: null, branches_tried: [], objections: [], reason: '' }
  const depBranches = it.depends.map(d => ({ branch: result.get(d).branch, head: result.get(d).head }))
  let feedback = ''
  let prevDiff = ''
  const fail = (attempt, stage, text) => { rec.history.push({ attempt, stage, result: text }) }
  for (let attempt = 1; attempt <= 1 + MAX_RETRIES; attempt++) {
    const branch = attempt === 1 ? `migrate/${it.id}` : `migrate/${it.id}-a${attempt}`
    rec.attempts = attempt
    rec.branches_tried.push(branch)
    const w = await spawn(workerPrompt(it, branch, attempt, feedback, prevDiff, depBranches),
      { agentType: AGENT('migration-worker'), isolation: 'worktree', label: `work:${it.id}:a${attempt}`, phase: 'Migrate', schema: WORK })
    if (!w) { rec.reason = 'worker failed or was skipped'; fail(attempt, 'worker', rec.reason); break }
    if (w.status === 'declined') { rec.reason = `worker declined: ${w.notes}`; fail(attempt, 'worker', rec.reason); break } // a retry would hit the same wall
    if (!w.worktree_path || !w.worktree_path.startsWith('/') || w.worktree_path.replace(/\/+$/, '') === root) {
      feedback = '- [isolation] the worker did not report an absolute worktree path distinct from the original checkout'
      fail(attempt, 'worker', feedback); continue
    }
    const g = await spawn(
      gatePrompt({ mode: 'item', dir: w.worktree_path, rollback: w.rollback_commit, branch, baseHead, depHeads: depBranches.map(d => d.head) }),
      { agentType: AGENT('migration-gate-runner'), label: `gate:${it.id}:a${attempt}`, phase: 'Migrate', schema: GATE })
    // Deterministic judgement. Everything below is code over the gate-runner's raw numbers and diff.
    const reasons = judgeRun(g, baseline, !!PREPARE)
    if (g) {
      if (w.branch !== branch) reasons.push({ kind: 'branch', detail: `worker reported branch "${w.branch}", expected "${branch}"` })
      if (g.current_branch !== branch) reasons.push({ kind: 'branch', detail: `git says the worktree is on "${g.current_branch}", expected "${branch}"` })
      if (!sameSha(g.branch_head, g.head)) reasons.push({ kind: 'branch', detail: `branch ${branch} resolves to ${g.branch_head || 'nothing'}, but the worktree HEAD is ${g.head}; the branch merge_order names would not hold this commit` })
      if (!sameSha(g.head, w.head_commit)) reasons.push({ kind: 'head_mismatch', detail: `gate saw HEAD ${g.head}, worker reported ${w.head_commit}` })
      if ((g.status_porcelain || '').trim()) reasons.push({ kind: 'dirty_tree', detail: `uncommitted or untracked files after the worker finished:\n${g.status_porcelain}` })
      const rb = g.rollback
      if (!rb) reasons.push({ kind: 'rollback', detail: 'rollback checks missing' })
      else {
        if (!sameSha(rb.sha, w.rollback_commit)) reasons.push({ kind: 'rollback', detail: `rollback commit ${rb.sha} differs from the worker's ${w.rollback_commit}` })
        if (!rb.is_ancestor_of_head) reasons.push({ kind: 'rollback', detail: 'rollback commit is not an ancestor of HEAD' })
        if (!rb.base_is_ancestor) reasons.push({ kind: 'rollback', detail: `the starting commit ${baseHead} is not an ancestor of the rollback commit: the worktree was cut from the wrong place` })
        if (!it.depends.length && !sameSha(rb.sha, baseHead)) reasons.push({ kind: 'rollback', detail: `an item without dependencies must roll back to ${baseHead}, got ${rb.sha}` })
        if (it.depends.length && !(rb.parents >= 2 && rb.deps_are_ancestors)) reasons.push({ kind: 'rollback', detail: 'an item with dependencies must roll back to the merge of all dependency branches (a merge commit containing every dependency head)' })
      }
      const diff = g.diff || ''
      if (!diff.trim()) reasons.push({ kind: 'empty_diff', detail: 'no change against the rollback commit' })
      // Every scan below reads the gate-runner's copy of the diff, so the copy must be whole before it is believed.
      const inDiff = new Set(diffPaths(diff))
      const claimed = [...new Set([...(g.files_changed || []), ...(w.files_changed || [])])]
      const missing = claimed.filter(p => !inDiff.has(p))
      if (missing.length) reasons.push({ kind: 'diff_incomplete', detail: `files reported changed have no section in the diff: ${missing.join(', ')}` })
      if (diff.trim() && !diffComplete(diff)) reasons.push({ kind: 'diff_incomplete', detail: 'a hunk holds fewer or more lines than its header announces: the diff was cut or abbreviated' })
      const gf = new Set(g.files_changed || [])
      const wf = new Set(w.files_changed || [])
      const gOnly = [...gf].filter(p => !wf.has(p))
      const wOnly = [...wf].filter(p => !gf.has(p))
      if (gOnly.length || wOnly.length) reasons.push({ kind: 'files_mismatch', detail: `git says changed: ${[...gf].join(', ') || 'none'}; worker said: ${[...wf].join(', ') || 'none'}` })
      const outside = [...new Set([...diffPaths(diff), ...(g.files_changed || [])])].filter(p => !inBoundary(p, it.boundary))
      if (outside.length) reasons.push({ kind: 'boundary', detail: `touched outside the boundary: ${outside.join(', ')}` })
      for (const h of scanDiff(diff)) reasons.push({ kind: 'silence', detail: `${h.kind}${h.what ? ' (' + h.what + ')' : ''} in ${h.file}: ${h.line || ''}` })
      if (diff.length > HARD.diffChars) {
        rec.reason = `diff is ${diff.length} characters, over the ${HARD.diffChars} the reviewer can read whole; a partial review is not a review`
        fail(attempt, 'gate', rec.reason); break
      }
    }
    if (reasons.length) {
      feedback = fmtReasons(reasons)
      prevDiff = (g && g.diff) || ''
      rec.reason = `gate failed: ${reasons.map(x => x.kind).join(', ')}`
      fail(attempt, 'gate', rec.reason)
      continue
    }
    // Blind review: the reviewer gets the diff, the boundary and the examples. Not the worker's notes, not the gate output.
    if (rec.review_rounds >= MAX_ROUNDS) { rec.reason = `review rounds exhausted (${MAX_ROUNDS})`; break }
    rec.review_rounds++
    const r = await spawn(
      `Review one migration item. Item: ${it.title}\nBoundary: ${it.boundary.join(', ')}\nRepository files for context may be read in this directory (read-only): ${w.worktree_path}\n` +
      `Decision records to read: ${RECORDS}\nReview round ${rec.review_rounds} of ${MAX_ROUNDS}.\n\nMigration description with examples:\n${description}\n\nDiff:\n${g.diff}`,
      { agentType: AGENT('migration-reviewer'), label: `review:${it.id}:r${rec.review_rounds}`, phase: 'Migrate', schema: REVIEW })
    if (!r) { rec.reason = 'reviewer failed or was skipped; an unreviewed item is not passed'; fail(attempt, 'review', rec.reason); break }
    const blockers = r.failures.filter(x => x.severity === 'blocker')
    rec.objections = r.failures
    if (r.verdict === 'PASS' && !blockers.length) {
      fail(attempt, 'review', 'PASS')
      rec.status = 'passed'; rec.branch = branch; rec.head = g.head; rec.rollback = g.rollback.sha; rec.reason = ''
      return rec
    }
    rec.reason = `review FAIL (${blockers.length} blocker(s))`
    fail(attempt, 'review', rec.reason)
    feedback = r.failures.map(x => `- [${x.severity}${x.kind ? ' ' + x.kind : ''}] ${x.file || ''}${x.line ? ':' + x.line : ''} ${x.problem}${x.needs ? ' Needs: ' + x.needs : ''}`).join('\n')
    prevDiff = g.diff
  }
  // BLOCKED. Its branch(es) stay for inspection and are never merged or deleted by this run.
  if (!rec.reason) rec.reason = 'attempts exhausted'
  if (rec.status === 'blocked' && rec.attempts >= 1 + MAX_RETRIES) rec.reason += ` (after ${rec.attempts} attempt(s), retry cap ${MAX_RETRIES})`
  return rec
}

for (let n = 0; n < waves.length; n++) {
  const ready = []
  for (const it of waves[n]) {
    const unmet = it.depends.filter(d => checkedStatus(d) !== 'passed')
    if (unmet.length) {
      result.set(it.id, { id: it.id, wave: n + 1, title: it.title, status: 'skipped', reason: `dependency ${unmet.map(d => `${d} was ${checkedStatus(d)}`).join(', ')}`, branch: null, branches_tried: [], history: [], objections: [] })
      log(`skipped ${it.id}: ${result.get(it.id).reason}`)
    } else ready.push(it)
  }
  if (ready.length && budget.total && budget.remaining() < MIN_BUDGET_PER_WAVE) {
    for (const it of ready) {
      result.set(it.id, { id: it.id, wave: n + 1, title: it.title, status: 'skipped', reason: `budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left, below ${MIN_BUDGET_PER_WAVE / 1000}k`, branch: null, branches_tried: [], history: [], objections: [] })
    }
    log(`budget guard: wave ${n + 1} and later items skipped`)
    continue
  }
  log(`wave ${n + 1}/${waves.length}: ${ready.length} item(s) to run, ${waves[n].length - ready.length} skipped`)
  // No barrier between the items of a wave: each streams through worker, gate and review on its own. The barrier at the
  // end of this await is a deliberate simplification, not a data edge: a wave n+1 item needs only the branches of its own
  // dependencies, so an unrelated slow or BLOCKED wave n item delays it for nothing. Upgrade path: start each item as soon as
  // its own dependencies have settled. Kept because the waves are what the plan, the budget guard and the report show.
  const outs = await pipeline(ready, it => withSlot(() => runItem(it, n).catch(e => ({
    id: it.id, wave: n + 1, title: it.title, status: 'blocked', reason: `item chain threw: ${e && e.message}`, attempts: 0, history: [], branch: null, branches_tried: [], objections: [] }))))
  ready.forEach((it, i) => {
    const r = outs[i]
    if (!r) { failed_stages.push({ stage: 'Migrate', id: it.id, why: 'pipeline returned null' }); result.set(it.id, { id: it.id, wave: n + 1, title: it.title, status: 'blocked', reason: 'pipeline returned null', attempts: 0, history: [], branch: null, branches_tried: [], objections: [] }) }
    else result.set(it.id, r)
    const rr = result.get(it.id)
    log(`${it.id}: ${rr.status}${rr.reason ? ' (' + rr.reason + ')' : ''}${rr.branch ? ' -> ' + rr.branch : ''}`)
  })
}

// ---------------------------------------------------------------- Report
phase('Report')
const all = waves.flat().map(it => result.get(it.id))
const passed = all.filter(r => r.status === 'passed')
const blocked = all.filter(r => r.status === 'blocked')
const skipped = all.filter(r => r.status === 'skipped')
const leftover = [...blocked, ...skipped].flatMap(r => r.branches_tried || [])
const merge_order = passed.map(r => r.branch)
log(`done: ${passed.length} passed, ${blocked.length} BLOCKED, ${skipped.length} skipped, ${dropped.length} dropped; peak concurrent worktrees ${peak}; agents ${spawned}/${HARD.agents}`)
if (blocked.length) log(`BLOCKED: ${blocked.map(r => `${r.id} (${r.reason})`).join('; ')}`)
if (skipped.length) log(`skipped dependents: ${skipped.map(r => `${r.id} (${r.reason})`).join('; ')}`)

const L = []
L.push('# Worktree migration report', '', `Baseline green at ${baseHead}. Canary rejected by the gate (${canary.rejected_by_run.join(', ')}). ${passed.length} of ${all.length} planned item(s) passed; ${blocked.length} BLOCKED, ${skipped.length} skipped because a dependency did not pass.`, '')
L.push('Nothing was merged, pushed or deleted. Branches that passed, in an order that merges cleanly (a branch already contains the branches it depends on):', '')
if (!passed.length) L.push('None.')
for (const r of passed) L.push(`- wave ${r.wave} ${r.id}: ${r.branch} (head ${r.head}, rolls back to ${r.rollback}, ${r.attempts} attempt(s), ${r.review_rounds} review round(s))`)
if (blocked.length) { L.push('', '## BLOCKED', ''); for (const r of blocked) L.push(`- ${r.id}: ${r.reason}. Branches left for inspection: ${(r.branches_tried || []).join(', ') || 'none'}.${r.objections && r.objections.length ? ' Open objections: ' + r.objections.map(o => o.problem).join(' | ') : ''}`) }
if (skipped.length) { L.push('', '## Skipped dependents', ''); for (const r of skipped) L.push(`- ${r.id}: ${r.reason}`) }
if (dropped.length || plan.unclassified.length) { L.push('', '## Not attempted', ''); for (const d of dropped) L.push(`- ${d.what}: ${d.why}`) }
if (failed_stages.length) { L.push('', '## Failed stages', ''); for (const s of failed_stages) L.push(`- ${s.stage} ${s.id}: ${s.why}`) }
L.push('', '## What was not verified', '', '- Only the build and test commands you gave were run. Behaviour they do not cover is verified by the blind reviewer alone.', '- The reviewer is not calibrated by a canary; only the gate is.')

return {
  status: passed.length === all.length && all.length ? 'all_passed' : passed.length ? 'partial' : 'none_passed',
  merge_order,
  passed: passed.map(r => ({ id: r.id, wave: r.wave, branch: r.branch, head: r.head, rollback: r.rollback, attempts: r.attempts, review_rounds: r.review_rounds })),
  blocked: blocked.map(r => ({ id: r.id, wave: r.wave, reason: r.reason, attempts: r.attempts, branches_tried: r.branches_tried, objections: r.objections })),
  skipped: skipped.map(r => ({ id: r.id, wave: r.wave, reason: r.reason })),
  dropped,
  truncated,
  unclassified: plan.unclassified,
  leftover_branches: leftover,
  canary,
  baseline: { head: baseHead, tests_total: baseline.tests_total === undefined ? null : baseline.tests_total },
  failed_stages,
  caps: { items: MAX_ITEMS, concurrency: CONC, peak_concurrency: peak, retries: MAX_RETRIES, rounds: MAX_ROUNDS, agents_spawned: spawned, agents_max: HARD.agents },
  report: L.join('\n'),
}
