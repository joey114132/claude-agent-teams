export const meta = {
  name: 'defect-hunt-until-dry',
  description: 'Hunt latent defects round by round: hunters per (module x lens), code dedupe against everything seen, a blind skeptic per fresh finding with one planted canary, stop after K dry rounds, then a read-only critic on the ranked report',
  whenToUse: 'A codebase slice of unknown quality needs a sweep whose findings are trustworthy enough to act on. Not for one diff or tiny files.',
  phases: [
    { title: 'Hunt', detail: 'one hunter per (module x lens), worker pool, hunter calls capped' },
    { title: 'Verify', detail: 'dedupe in code vs every finding seen, then one blind skeptic per fresh finding, plus a canary' },
    { title: 'Critique', detail: 'read-only critic on the ranked report, 3 rounds max' },
  ],
}

// Ideas (reimplemented, no text copied): per-issue validation agents from github.com/anthropics/claude-code/tree/main/plugins/code-review;
// separate verification agents from anthropic.com/engineering/multi-agent-research-system; fresh-context reviewer per claim from github.com/addyosmani/agent-skills (MIT).
// args: { root, modules: ["<paths>"], records: ["<decision record paths>"], lenses?: ["..."],
//         maxRounds?: 5, dryRounds?: 2, maxHunters?: 60, perRound?, concurrency?: 6, maxVerifyPerRound?: 20, agentPrefix?: "agent-teams:" }
// agentPrefix goes in front of each agent name. The default fits a plugin install; pass "" for bare agents (symlinks, --plugin-dir).
// Pass args as an object. A JSON string is accepted and parsed, because a stringified object is a common slip.
//
// Wall clock: a script cannot read a clock (Date.now is blocked), so the time limit is the timeout the caller puts on the
// Workflow call itself (see the skill). The caps below bound the work in agent calls; they do not bound seconds.
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { return { error: 'args arrived as a string that is not JSON; pass an object {root, modules, records}; nothing was hunted' } }
}
if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'needs args {root, modules: [paths], records: [decision record paths]}; nothing was hunted' }

const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [])
const posInt = (v, d, hi) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? Math.min(n, hi) : d }

const root = typeof input.root === 'string' ? input.root.trim().replace(/\/+$/, '') : ''
const modules = strList(input.modules)
const records = strList(input.records)
if (!root || !modules.length) return { error: 'needs args {root, modules: [paths], records: [decision record paths]}; root and at least one module are required; nothing was hunted' }
const PREFIX = input.agentPrefix !== undefined ? input.agentPrefix : 'agent-teams:'
if (typeof PREFIX !== 'string') return { error: 'agentPrefix must be a string ("" for bare agent names); nothing was hunted' }
const AGENT = name => PREFIX + name

const LENS_FOCUS = {
  'correctness': 'Logic that does the wrong thing on inputs the code really receives: inverted or off-by-one conditions, wrong operator, unit or type mix-ups, bad state transitions, wrong default.',
  'silent failure and error handling': 'Errors swallowed or ignored: empty catch, unchecked return values, fallbacks that hide a failure, success reported after a failed step, partial writes left behind.',
  'concurrency and lifetime': 'Races, check-then-act, lock ordering, shared mutable state, use after close or free, callbacks that outlive their owner, missing cancellation or shutdown.',
  'security boundary': 'Untrusted input reaching a sink without validation: injection, path traversal, unsafe deserialization, authorization checks that can be skipped, secrets in logs.',
  'api contract': 'Caller and callee that disagree: documented versus actual behaviour, nullability, ordering requirements, error shapes, mutated arguments, defaults that break callers.',
  'resource leaks': 'Handles, files, sockets, processes, listeners, timers or caches acquired and not released on every path, error paths included, and unbounded growth.',
}
const lensInput = strList(input.lenses)
const LENSES = lensInput.length ? lensInput : Object.keys(LENS_FOCUS)

const MAX_ROUNDS = posInt(input.maxRounds, 5, 5)
const MAX_HUNTERS = posInt(input.maxHunters, 60, 60)
const DRY_K = posInt(input.dryRounds, 2, 5)
const CONCURRENCY = posInt(input.concurrency, 6, 12)
const MAX_VERIFY = posInt(input.maxVerifyPerRound, 20, 40)
const MAX_PER_HUNTER = 8
const CRITIC_ROUNDS = 3
const MIN_BUDGET = 150000

// Cells = module x lens, lens-major so a cut by the hunter cap drops the last lenses on every module evenly.
const cells = []
for (const lens of LENSES) for (const module of modules) cells.push({ idx: cells.length, module, lens, runs: 0, failed: 0, confirmed: 0 })
const PER_ROUND = posInt(input.perRound, Math.max(1, Math.min(cells.length, Math.floor(MAX_HUNTERS / MAX_ROUNDS))), cells.length)

const SEV = ['high', 'medium', 'low']
const RANK = { high: 0, medium: 1, low: 2 }
const rel = f => { let s = String(f || '').trim(); if (s.startsWith(root + '/')) s = s.slice(root.length + 1); return s.replace(/^\.\//, '') }
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) }
const STOP = new Set(['the', 'an', 'is', 'are', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'not', 'no', 'without', 'before', 'after', 'when', 'for', 'by', 'with', 'be', 'can', 'may', 'if', 'it', 'this', 'that', 'from', 'as', 'does', 'do'])
const toks = t => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w)))
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n) }

// Dedupe key. Same file and either a near-identical title (Jaccard >= 0.75), or line ranges within 2 lines of each other
// that are both narrow (<= NARROW lines) and come from the same lens or share some title words (Jaccard >= 0.3).
// Title similarity never crosses files, because a generic title ("unchecked return value") would otherwise let one refuted finding
// hide a real one elsewhere. A wide range or a different lens with an unrelated title never merges on lines alone: the hunter prompt
// promises that a different defect on the same lines is fine, and a refuted wide finding must not swallow it.
const LINE_SLACK = 2
const TITLE_SIM = 0.75
const TITLE_LOOSE = 0.3
const NARROW = 15
const narrow = x => x.e - x.s <= NARROW
const sameDefect = (a, b) => {
  if (a.file !== b.file) return false
  const j = jaccard(a.tokens, b.tokens)
  if (j >= TITLE_SIM) return true
  return a.s <= b.e + LINE_SLACK && b.s <= a.e + LINE_SLACK && narrow(a) && narrow(b) && (a.lens === b.lens || j >= TITLE_LOOSE)
}

const CANDIDATES = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line_start: { type: 'integer' },
          line_end: { type: 'integer' },
          claim: { type: 'string' },
          evidence_quote: { type: 'string' },
          impact: { type: 'string' },
          suggested_severity: { type: 'string', enum: SEV },
        },
        required: ['title', 'file', 'line_start', 'line_end', 'claim', 'evidence_quote', 'impact', 'suggested_severity'],
      },
    },
  },
  required: ['candidates'],
}

const VERDICT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    real: { type: 'boolean' },
    severity_ok: { type: 'boolean' },
    corrected_severity: { type: 'string', enum: SEV },
    closed_by_record: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['id', 'real', 'severity_ok', 'closed_by_record', 'reason'],
}

const GUARD = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    file: { type: 'string' },
    guard_line: { type: 'integer' },
    guard_text: { type: 'string' },
    checked_value: { type: 'string' },
    exits_when_invalid: { type: 'boolean' },
    next_line: { type: 'integer' },
    next_line_text: { type: 'string' },
  },
  required: ['found'],
}

const CRITIC = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding_id: { type: 'string' },
          check: { type: 'string', enum: ['line_missing', 'refuted_listed', 'duplicate', 'severity', 'closed_by_record', 'other'] },
          problem: { type: 'string' },
          needs: { type: 'string' },
          severity_should_be: { type: 'string', enum: SEV },
        },
        required: ['finding_id', 'check', 'problem', 'needs'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['verdict', 'failures', 'notes'],
}

const RECORDS_TEXT = records.length ? records.join(', ') : '(none listed: search the repository for intent, ADR, troubleshooting, decision and handoff files, and say which you found)'

// ---- state ----
const seen = []           // every finding ever dedupe-checked: {file, s, e, tokens, title, status, round}; status queued|confirmed|refuted|closed|unverified
const confirmed = []      // real, not closed by a record
const refuted = []
const closed = []
const unverified = []
let backlog = []          // fresh candidates the per-round verify cap pushed to a later batch
const roundLog = []
const canary = { forged: null, finderCalls: 1, injected: 0, caught: false, failed: false, detail: null }
let hunterCalls = 0
let skepticCalls = 0
let truncatedCandidates = 0
const duplicatesDropped = []   // every candidate the dedupe merged away, with the seen entry that absorbed it
let malformedCandidates = 0
let round = 0
let dry = 0
let stopReason = null

// ---- canary: an agent greps a real guard clause, code forges the false claim from it ----
// Started now so it runs while the first hunters work. A script has no filesystem access, which is why an agent does the grep.
const canaryPromise = Promise.resolve()
  .then(() => agent(
    `Read-only. In ${root}, within these modules: ${modules.join(', ')}, find ONE real guard clause: a conditional that tests a value and leaves the function (return, raise, throw, continue, break) when the value is invalid, followed by a statement that is safe BECAUSE of that guard.\n` +
    `Pick a guard that really exits. A guard that only logs and carries on is not acceptable. Open the file and copy the exact text.\n` +
    `Return the file, the line of the guard condition, its text, the name of the value it checks, whether it exits when the value is invalid, the line number of the first statement after the guard block and the text of that statement. ` +
    `If you cannot find one, return found=false.`,
    { agentType: AGENT('guard-finder'), label: 'canary:find-guard', phase: 'Verify', schema: GUARD }))
  .catch(() => null)

function forgeCanary(g) {
  if (!g || g.found !== true || g.exits_when_invalid !== true) return null
  const file = rel(g.file)
  const gl = Math.trunc(g.guard_line)
  const nl = Math.trunc(g.next_line)
  const v = typeof g.checked_value === 'string' ? g.checked_value.trim() : ''
  if (!file || !v || !(gl >= 1) || !(nl > gl) || !g.next_line_text) return null
  return {
    title: `Unchecked ${v} used right after its guard`,
    file, line_start: nl, line_end: nl, severity: 'high',
    claim: `${v} is used at line ${nl} without being validated; the guard at line ${gl} does not protect this statement.`,
    evidence_quote: g.next_line_text,
    impact: 'An invalid value reaches this statement unchecked and produces a wrong result or a crash.',
  }
}

// ---- hunting ----
function seenSummary() {
  const MAX_LINES = 120
  const lines = seen.map(x => `${x.file}:${x.s}-${x.e} ${x.title} [${x.status}]`)
  const omitted = Math.max(0, lines.length - MAX_LINES)
  return { text: lines.slice(-MAX_LINES).join('\n'), omitted }
}

function huntPrompt(cell, sm) {
  const focus = LENS_FOCUS[cell.lens] ?? cell.lens
  return `Defect hunt, read-only, round ${round}. Edit nothing, run nothing.\n` +
    `Root: ${root}\nModule: ${cell.module}\nYour lens: ${cell.lens}. ${focus}\n` +
    `Stay on this lens; other hunters cover the other lenses on this module.\n` +
    `Decision records you MUST read before reporting anything: ${RECORDS_TEXT}.\n` +
    `Drop anything a record fixes, rejects or deliberately scopes out. An open question or pending decision is not a closing record.\n` +
    `Report at most ${MAX_PER_HUNTER} candidates, strongest first. No style, naming or speculation that depends on inputs you cannot show. Every candidate needs lines you opened and a verbatim evidence quote.\n` +
    (sm.text
      ? `Already seen in earlier rounds (any status). Do not report these again; a different defect on the same lines is fine:\n${sm.text}\n${sm.omitted ? `(${sm.omitted} older entries omitted)\n` : ''}`
      : 'Nothing has been seen yet.\n')
}

function clean(c, cell) {
  if (!c || typeof c.title !== 'string' || typeof c.file !== 'string') return null
  const file = rel(c.file)
  const s = Math.trunc(c.line_start)
  const e = Math.trunc(c.line_end)
  if (!file || !c.title.trim() || !(s >= 1)) return null
  return {
    title: c.title.trim(), file, line_start: s, line_end: e >= s ? e : s,
    claim: String(c.claim || ''), evidence_quote: String(c.evidence_quote || ''), impact: String(c.impact || ''),
    severity: SEV.includes(c.suggested_severity) ? c.suggested_severity : 'medium',
    cell: cell.idx, module: cell.module, lens: cell.lens, round,
  }
}

// ---- verification ----
const verifyPrompt = (f, vid) =>
  `Verify one claimed defect in the code at ${root}.\n` +
  `title: ${f.title}\nfile: ${f.file}\nlines: ${f.line_start}-${f.line_end}\nclaimed severity: ${f.severity}\nclaim: ${f.claim}\nevidence quote: ${f.evidence_quote}\nimpact: ${f.impact}\n\n` +
  `Try to REFUTE it. Open the cited file and lines, follow callers one or two hops, and read these decision records for an entry that fixes, rejects or deliberately scopes it out: ${RECORDS_TEXT}. ` +
  `If you cannot confirm it, real is false. Return id "${vid}".`

async function verifyBatch(items) {
  const stages = items.map(f => ({ kind: 'real', f, vid: 'v' + hash(`${f.file}|${f.line_start}|${f.title}|${f.round}`) }))
  const canaryDue = canary.forged && !canary.caught && !canary.failed && items.length > 0
  if (canaryDue) {
    const c = canary.forged
    const st = { kind: 'canary', f: c, vid: 'v' + hash(`${c.file}|${c.line_start}|${c.title}|canary`) }
    stages.splice(parseInt(st.vid.slice(1), 36) % (stages.length + 1), 0, st)
    canary.injected++
  }
  skepticCalls += stages.length
  const verdicts = await pipeline(stages, st => agent(verifyPrompt(st.f, st.vid),
    { agentType: AGENT('defect-skeptic'), label: `verify:${st.vid}`, phase: 'Verify', schema: VERDICT }))

  const out = { confirmed: 0, refuted: 0, closed: 0, unverified: 0 }
  const real = []
  stages.forEach((st, i) => {
    const v = verdicts[i]
    const answered = v && v.id === st.vid
    if (st.kind === 'canary') {
      if (!answered) return log('canary skeptic did not return a usable verdict: this batch is uncalibrated')
      canary.detail = v.reason
      if (v.real === true) canary.failed = true; else canary.caught = true
      return
    }
    const f = st.f
    const entry = f.entry
    if (!answered) {
      entry.status = 'unverified'
      unverified.push({ ...pub(f), reason: v ? 'skeptic returned a mismatched id' : 'skeptic did not return' })
      out.unverified++
    } else if (!v.real) {
      entry.status = 'refuted'
      refuted.push({ ...pub(f), reason: v.reason })
      out.refuted++
    } else if (v.closed_by_record) {
      entry.status = 'closed'
      closed.push({ ...pub(f), reason: v.reason })
      out.closed++
    } else {
      entry.status = 'confirmed'
      const disputed = v.severity_ok === false
      const fixed = disputed && SEV.includes(v.corrected_severity)
      real.push({ ...pub(f), suggested_severity: f.severity, severity: fixed ? v.corrected_severity : f.severity, severity_disputed: disputed && !fixed,
        claim: f.claim, evidence_quote: f.evidence_quote, impact: f.impact, skeptic_reason: v.reason,
        found_in: { module: f.module, lens: f.lens, round: f.round } })
      cells[f.cell].confirmed++
      out.confirmed++
    }
  })
  confirmed.push(...real)
  return out
}
const pub = f => ({ title: f.title, file: f.file, line_start: f.line_start, line_end: f.line_end, severity: f.severity })

// ---- the loop ----
let canaryResolved = false
while (true) {
  if (round >= MAX_ROUNDS) { stopReason = 'max_rounds'; break }
  if (hunterCalls >= MAX_HUNTERS) { stopReason = 'hunter_cap'; break }
  if (budget.total && budget.remaining() < MIN_BUDGET) { stopReason = 'budget'; log(`budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left, below ${MIN_BUDGET / 1000}k; no more hunting`); break }
  round++
  phase('Hunt')

  // Coverage first (cells never run), then cells that already paid off, then the least-run rest.
  const tier = c => (c.runs === 0 ? 0 : c.confirmed > 0 ? 1 : 2)
  const batch = [...cells].sort((a, b) => tier(a) - tier(b) || a.runs - b.runs || a.idx - b.idx).slice(0, Math.min(PER_ROUND, MAX_HUNTERS - hunterCalls))
  const sm = seenSummary()
  const results = new Array(batch.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < batch.length) {
      const i = next++
      try {
        results[i] = await agent(huntPrompt(batch[i], sm),
          { agentType: AGENT('defect-hunter'), label: `hunt:r${round}:${batch[i].module}:${batch[i].lens}`, phase: 'Hunt', schema: CANDIDATES })
      } catch (e) { results[i] = null }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker))
  hunterCalls += batch.length

  // BARRIER, and a real one: dedupe has to see every candidate of this round and the whole seen set, or a refuted finding
  // comes back every round and the dry streak never ends.
  let failedHunters = 0
  const cands = []
  results.forEach((r, i) => {
    const cell = batch[i]
    if (!r || !Array.isArray(r.candidates)) { cell.failed++; failedHunters++; return }
    cell.runs++
    if (r.candidates.length > MAX_PER_HUNTER) {
      truncatedCandidates += r.candidates.length - MAX_PER_HUNTER
      log(`hunt ${cell.module} x ${cell.lens}: ${r.candidates.length - MAX_PER_HUNTER} candidates over the per-hunter cap of ${MAX_PER_HUNTER} not considered`)
    }
    for (const c of r.candidates.slice(0, MAX_PER_HUNTER)) {
      const k = clean(c, cell)
      if (k) cands.push(k)
      else malformedCandidates++
    }
  })
  cands.sort((a, b) => RANK[a.severity] - RANK[b.severity])   // stable: the highest severity is the one kept when two merge
  const fresh = []
  const dup = { total: 0, of_confirmed: 0, of_refuted: 0, of_closed: 0, of_unverified: 0, of_queued: 0 }
  for (const c of cands) {
    const probe = { file: c.file, s: c.line_start, e: c.line_end, tokens: toks(c.title), lens: c.lens }
    const m = seen.find(x => sameDefect(x, probe))
    if (m) {
      dup.total++; dup['of_' + m.status]++
      duplicatesDropped.push({ round, title: c.title, file: c.file, line_start: c.line_start, line_end: c.line_end, lens: c.lens,
        absorbed_by: { title: m.title, file: m.file, line_start: m.s, line_end: m.e, status: m.status } })
      continue
    }
    const entry = { ...probe, title: c.title, status: 'queued', round }
    seen.push(entry)
    c.entry = entry
    fresh.push(c)
  }
  log(`round ${round}: ${batch.length} hunters (${failedHunters} failed), ${cands.length} candidates, ${dup.total} duplicates (${dup.of_refuted} of refuted), ${fresh.length} fresh`)
  for (const d of duplicatesDropped.filter(x => x.round === round)) log(`duplicate dropped: "${d.title}" (${d.file}:${d.line_start}-${d.line_end}, ${d.lens}) absorbed by "${d.absorbed_by.title}" (${d.absorbed_by.file}:${d.absorbed_by.line_start}-${d.absorbed_by.line_end}) [${d.absorbed_by.status}]`)

  phase('Verify')
  if (!canaryResolved) {
    canaryResolved = true
    const g = await canaryPromise
    canary.forged = forgeCanary(g)
    if (!canary.forged) log('canary-less: no usable guard clause found in the target; this run cannot be calibrated and its results will be reported as unverified')
  }
  const pending = [...backlog, ...fresh].sort((a, b) => RANK[a.severity] - RANK[b.severity])
  const toVerify = pending.slice(0, MAX_VERIFY)
  backlog = pending.slice(MAX_VERIFY)
  if (backlog.length) log(`verify cap ${MAX_VERIFY} per round: ${backlog.length} queued for the next batch`)
  const v = toVerify.length ? await verifyBatch(toVerify) : { confirmed: 0, refuted: 0, closed: 0, unverified: 0 }

  const fullyCovered = cells.every(c => c.runs > 0)
  roundLog.push({ round, hunters: batch.length, failed_hunters: failedHunters, candidates: cands.length, duplicates: dup, fresh: fresh.length,
    verified: toVerify.length, confirmed: v.confirmed, refuted: v.refuted, closed_by_record: v.closed, unverified: v.unverified, backlog: backlog.length, fully_covered: fullyCovered })
  log(`round ${round}: confirmed ${v.confirmed}, refuted ${v.refuted}, closed by record ${v.closed}, unverified ${v.unverified}, backlog ${backlog.length}`)

  if (canary.failed) { stopReason = 'canary_failed'; break }
  if (v.confirmed > 0) dry = 0
  // A round only counts as dry when it could have found something: every cell has run, nothing is waiting for a skeptic, no hunter
  // failed and no skeptic failed to answer (an unverified finding is a gap, not a refutation).
  else if (fullyCovered && backlog.length === 0 && failedHunters === 0 && v.unverified === 0) dry++
  if (dry >= DRY_K) { stopReason = 'dry'; break }
}

// Drain: findings the loop left in the backlog get one more verification pass; what is still left goes to notChecked.
if (backlog.length && !canary.failed && !(budget.total && budget.remaining() < MIN_BUDGET)) {
  phase('Verify')
  const pending = backlog
  backlog = pending.slice(MAX_VERIFY)
  const v = await verifyBatch(pending.slice(0, MAX_VERIFY))
  log(`drain: confirmed ${v.confirmed}, refuted ${v.refuted}, closed by record ${v.closed}, unverified ${v.unverified}, still not checked ${backlog.length}`)
  roundLog.push({ round: 'drain', verified: pending.length - backlog.length, confirmed: v.confirmed, refuted: v.refuted, closed_by_record: v.closed, unverified: v.unverified, backlog: backlog.length })
}
const notChecked = backlog.map(f => ({ ...pub(f), reason: 'over the verify cap or budget; never reached a skeptic' }))
const cellsNotRun = cells.filter(c => c.runs === 0).map(c => ({ module: c.module, lens: c.lens, failed_attempts: c.failed }))
if (notChecked.length) log(`not checked: ${notChecked.map(f => `${f.title} (${f.file}:${f.line_start})`).join('; ')}`)
if (cellsNotRun.length) log(`cells never run (cap or failure): ${cellsNotRun.map(c => `${c.module} x ${c.lens}`).join('; ')}`)
if (truncatedCandidates || malformedCandidates) log(`candidates dropped: ${truncatedCandidates} over the per-hunter cap, ${malformedCandidates} malformed`)

// ---- canary verdict ----
let canaryStatus
if (canary.failed) canaryStatus = 'failed'
else if (!canaryResolved) canaryStatus = 'not_run'
else if (!canary.forged) canaryStatus = 'canary-less'
else if (canary.caught) canaryStatus = 'caught'
else if (canary.injected) canaryStatus = 'uncalibrated'
else canaryStatus = 'not_run'

// What the canary was built from and why the skeptic said what it said. The finder's self-reported guard is not checked by code,
// so a caught canary is only as good as this reason: read it.
const canaryDetail = () => canary.forged ? { forged: { file: canary.forged.file, line: canary.forged.line_start, claim: canary.forged.claim }, skeptic_reason: canary.detail } : null
const common = () => ({
  stop_reason: stopReason, canary: canaryStatus, canary_detail: canaryDetail(), rounds: roundLog, closed_by_record: closed, refuted, unverified, notChecked,
  cells_not_run: cellsNotRun, records_listed: records.length > 0,
  dropped: { candidates_over_hunter_cap: truncatedCandidates, malformed_candidates: malformedCandidates, duplicates: duplicatesDropped },
  caps_used: { rounds: round, hunter_calls: hunterCalls, skeptic_calls: skepticCalls, canary_finder_calls: 1, max: { rounds: MAX_ROUNDS, hunter_calls: MAX_HUNTERS, dry_rounds: DRY_K, verify_per_round: MAX_VERIFY, critic_rounds: CRITIC_ROUNDS } },
})
const demote = reason => { for (const f of confirmed.splice(0)) unverified.push({ title: f.title, file: f.file, line_start: f.line_start, line_end: f.line_end, severity: f.severity, reason }) }

if (canaryStatus === 'failed') {
  const msg = `canary_failed: the skeptic called the planted false finding real (${canary.detail}). None of its verdicts can be trusted, so nothing is reported as confirmed.`
  log(msg)
  demote('canary confirmed: verdicts of this run are void')
  return { error: 'canary_failed', detail: msg, status: 'canary_failed', confirmed: [], ...common() }
}
if (canaryStatus === 'canary-less' || canaryStatus === 'uncalibrated') {
  const why = canaryStatus === 'canary-less' ? 'canary-less run' : 'canary skeptic never returned a verdict'
  if (confirmed.length) log(`${why}: ${confirmed.length} confirmed findings reported as unverified`)
  demote(`${why}: skeptic verdicts could not be calibrated`)
  return { status: canaryStatus, confirmed: [], critic: { verdict: 'not_run', rounds: 0, open_objections: [], dropped: [] }, ...common() }
}

// ---- critic ----
let report = confirmed
  .map((f, i) => ({ f, i }))
  .sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i)
  .map(({ f }, n) => ({ id: `D${n + 1}`, ...f }))
const dropped = []
let criticVerdict = 'not_run'
let criticRounds = 0
let openObjections = []

const reportView = () => report.map(f => ({ id: f.id, severity: f.severity, title: f.title, file: f.file, line_start: f.line_start, line_end: f.line_end, claim: f.claim, evidence_quote: f.evidence_quote, impact: f.impact, skeptic_reason: f.skeptic_reason }))
const DROP_CHECKS = new Set(['line_missing', 'refuted_listed', 'duplicate', 'closed_by_record'])
function applyFixes(failures) {
  let changed = false
  for (const x of failures) {
    const i = report.findIndex(f => f.id === x.finding_id)
    if (i < 0) continue
    if (DROP_CHECKS.has(x.check)) {
      dropped.push({ ...report[i], dropped_because: x.check, critic_said: x.problem })
      report.splice(i, 1)
      changed = true
    } else if (x.check === 'severity' && SEV.includes(x.severity_should_be) && x.severity_should_be !== report[i].severity) {
      report[i] = { ...report[i], severity: x.severity_should_be, severity_changed_by_critic: true }
      changed = true
    }
  }
  report.sort((a, b) => RANK[a.severity] - RANK[b.severity])
  return changed
}

if (report.length) {
  phase('Critique')
  for (let r = 1; r <= CRITIC_ROUNDS && report.length; r++) {
    let res = null
    try { res = await agent(
      `Check this ranked defect report. Root: ${root}.\nDecision records to read: ${RECORDS_TEXT}.\n\n` +
      `REPORT (${report.length} findings, highest severity first):\n${JSON.stringify(reportView(), null, 1)}\n\n` +
      `REFUTED FINDINGS (none of these may appear in the report):\n${refuted.length ? refuted.map(x => `${x.file}:${x.line_start}-${x.line_end} ${x.title}`).join('\n') : '(none)'}\n\n` +
      `Return PASS or the list of failures. Use the ids D1, D2, ... from the report.`,
      { agentType: AGENT('hunt-report-critic'), label: `critic:r${r}`, phase: 'Critique', schema: CRITIC })
    } catch (e) { log(`critic round ${r} threw (${e && e.message}): the report is unreviewed`) }
    criticRounds = r
    if (!res) { criticVerdict = 'not_run'; log(`critic round ${r} did not return: the report is unreviewed`); break }
    if (res.verdict === 'PASS' && !res.failures.length) { criticVerdict = 'PASS'; openObjections = []; break }
    criticVerdict = 'FAIL'
    openObjections = res.failures
    if (r === CRITIC_ROUNDS) break
    if (!applyFixes(res.failures)) { log(`critic round ${r}: failures need a human, no mechanical fix applies`); break }
    log(`critic round ${r}: applied fixes, ${dropped.length} dropped so far, rechecking`)
  }
  if (criticVerdict === 'FAIL') log(`critic did not pass the report after ${criticRounds} round(s): ${openObjections.length} open objections attached`)
}
if (dropped.length) log(`dropped by critic: ${dropped.map(f => `${f.id} ${f.title} (${f.dropped_because})`).join('; ')}`)

return {
  status: 'ok',
  confirmed: report,
  critic: { verdict: criticVerdict, rounds: criticRounds, open_objections: openObjections, dropped },
  note: report.length ? undefined : 'no confirmed findings; that is not proof the code is clean, only that this sweep found nothing a skeptic could confirm',
  ...common(),
}
