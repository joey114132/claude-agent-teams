export const meta = {
  name: 'design-panel',
  description: 'Blind-scored competing designs that end in an ADR: independent proposers, a planted canary, anonymised per-juror-ordered rubric scoring, a spread check in code, one scribe, and a read-only critic loop (3 rounds at most)',
  phases: [
    { title: 'Propose', detail: 'up to 5 independent proposers (one fixed lens each) plus one canary proposal' },
    { title: 'Score', detail: 'up to 3 jurors score anonymised proposals; canary and spread checks run in code' },
    { title: 'Record', detail: 'one scribe writes the ADR, a read-only critic checks it (3 rounds at most)' },
  ],
}

// args: { decision: "<what must be decided>", constraints: ["<hard constraint>", ...], records: ["<decision record paths>"],
//         adrPath: "<where the ADR goes, ending in .md>", root?: "<repo path>", bottleneck?: "<what to optimise for>",
//         proposers?: 5, jurors?: 3, rounds?: 3, canary?: {title, design, riskiest_assumption, cheapest_test, cost_to_reverse, rejected_sub_options, basis_ref} (all required), agentPrefix?: "agent-teams:" }
// Caps are hard: 5 proposers, 3 jurors, 1 canary, 3 critic rounds. Asking for more is clamped and logged.
// Wall clock is NOT enforceable here (no clock in a script): set a timeout on the Workflow call itself.
// agentPrefix is put in front of each agent name. The default fits a plugin install; pass "" when the agents are
// installed bare (symlinks into ~/.claude/agents, or --plugin-dir). Pass args as an object; a JSON string is parsed.
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { return { error: 'args arrived as a string that is not JSON; pass an object {decision, constraints, records, adrPath}; nothing was run' } }
}
if (!input || typeof input !== 'object') return { error: 'needs args {decision, constraints, records, adrPath}; nothing was run' }

const asList = v => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
const decision = typeof input.decision === 'string' ? input.decision.trim() : ''
const constraints = asList(input.constraints)
const records = asList(input.records)
const root = typeof input.root === 'string' ? input.root : ''
const adrPath = typeof input.adrPath === 'string' ? input.adrPath.trim() : ''
const PREFIX = input.agentPrefix !== undefined ? input.agentPrefix : 'agent-teams:'
if (typeof PREFIX !== 'string') return { error: 'agentPrefix must be a string ("" for bare agent names); nothing was run' }
const AGENT = name => PREFIX + name

const missing = []
const callerCanary = input.canary && typeof input.canary === 'object' ? input.canary : null
if (callerCanary) {
  // A caller canary must look like a real proposal. Placeholder fields ("(not stated)", no rejected options) would give it away.
  const need = ['title', 'design', 'riskiest_assumption', 'cheapest_test', 'cost_to_reverse', 'basis_ref'].filter(k => typeof callerCanary[k] !== 'string' || !callerCanary[k].trim())
  if (!Array.isArray(callerCanary.rejected_sub_options) || !callerCanary.rejected_sub_options.length) need.push('rejected_sub_options (array of {option, reason})')
  if (need.length) missing.push(`canary is incomplete, a half-filled canary gives itself away to the jurors: ${need.join(', ')}`)
}
if (!decision) missing.push('decision (string)')
if (!constraints.length) missing.push('constraints (at least one hard constraint, or the jurors have nothing to ground scores in)')
if (!records.length) missing.push('records (paths of decision records: ADRs, intent.md, wiki; without them nodes will re-litigate decided questions)')
if (!/\.md$/.test(adrPath)) missing.push('adrPath (a path ending in .md)')
if (missing.length) return { error: `missing input: ${missing.join('; ')}. Nothing was run.` }

const HARD = { proposers: 5, jurors: 3, rounds: 3 }
const MIN = { proposers: 2, jurors: 2 }
const want = (v, dflt) => (v === undefined ? dflt : Number(v))
const caps_applied = []
const cap = (name, v) => {
  if (!Number.isInteger(v)) return null
  if (v > HARD[name]) { caps_applied.push(`${name}: asked ${v}, capped at ${HARD[name]}`); return HARD[name] }
  return v
}
const N_PROP = cap('proposers', want(input.proposers, HARD.proposers))
const N_JUR = cap('jurors', want(input.jurors, HARD.jurors))
const MAX_ROUNDS = cap('rounds', want(input.rounds, HARD.rounds))
if (N_PROP === null || N_JUR === null || MAX_ROUNDS === null) return { error: 'proposers, jurors and rounds must be integers; nothing was run' }
if (N_PROP < MIN.proposers || N_JUR < MIN.jurors || MAX_ROUNDS < 1) return { error: `need at least ${MIN.proposers} proposers, ${MIN.jurors} jurors and 1 round (a comparison needs two options and a spread needs two jurors); nothing was run` }
caps_applied.forEach(c => log(`cap: ${c}`))

const MIN_BUDGET_TO_SCORE = 120000
const MIN_BUDGET_TO_RECORD = 60000
const BOTTLENECK = typeof input.bottleneck === 'string' && input.bottleneck.trim() ? input.bottleneck.trim() : ''

const LENSES = [
  { key: 'smallest-change', text: 'Smallest change: the design that touches the fewest files, contracts and moving parts while still meeting every hard constraint.' },
  { key: 'most-reversible', text: 'Most reversible: the design that is cheapest and safest to undo after months of use, even if it costs more now.' },
  { key: 'best-operability', text: 'Best operability: the design the team can run, debug, monitor and hand over most easily at 3am.' },
  { key: 'buy-not-build', text: 'Buy, not build: the design that leans on an existing product, managed service or library the project already has or can adopt, and writes the least new code.' },
  { key: 'bottleneck', text: `Optimise for the stated bottleneck: ${BOTTLENECK || 'the bottleneck the constraints imply (name it first, then design for it)'}.` },
]

if (N_PROP < LENSES.length) {
  const msg = `lenses not run (proposers=${N_PROP}): ${LENSES.slice(N_PROP).map(l => l.key).join(', ')}`
  caps_applied.push(msg); log(`cap: ${msg}`)
  if (BOTTLENECK) { const m = 'the supplied bottleneck is ignored because the bottleneck lens is the last one'; caps_applied.push(m); log(`cap: ${m}`) }
}

const CRITERIA = ['correctness_vs_constraints', 'reversibility', 'operability', 'fit_with_existing_code', 'blast_radius']

const PROPOSAL = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    design: { type: 'string' },
    rejected_sub_options: { type: 'array', items: { type: 'object', properties: { option: { type: 'string' }, reason: { type: 'string' } }, required: ['option', 'reason'] } },
    riskiest_assumption: { type: 'string' },
    cheapest_test: { type: 'string' },
    cost_to_reverse: { type: 'string' },
    records_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'design', 'rejected_sub_options', 'riskiest_assumption', 'cheapest_test', 'cost_to_reverse', 'records_read'],
}
const CANARY = {
  ...PROPOSAL,
  properties: {
    ...PROPOSAL.properties,
    canary_basis: { type: 'string', enum: ['rejected_by_record', 'violates_hard_constraint'] },
    basis_ref: { type: 'string' },
  },
  required: [...PROPOSAL.required, 'canary_basis', 'basis_ref'],
}
const CRIT = { type: 'object', properties: { score: { type: 'integer', minimum: 0, maximum: 5 }, cite: { type: 'string' } }, required: ['score', 'cite'] }
const SCORES = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          criteria: { type: 'object', properties: Object.fromEntries(CRITERIA.map(k => [k, CRIT])), required: CRITERIA },
          hard_constraint_violation: { type: 'string' },
          rejected_by_record: { type: 'boolean' },
          record_ref: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['label', 'criteria', 'hard_constraint_violation', 'rejected_by_record', 'rationale'],
      },
    },
    records_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['scores', 'records_read'],
}
const SCRIBE = { type: 'object', properties: { path: { type: 'string' }, notes: { type: 'string' } }, required: ['path', 'notes'] }
const CRITIC = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    failures: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, detail: { type: 'string' } }, required: ['check', 'detail'] } },
  },
  required: ['verdict', 'failures'],
}

const HEAD = `Decision to make: ${decision}
Hard constraints (cite them by id):
${constraints.map((c, i) => `C${i + 1}. ${c}`).join('\n')}
${root ? `Code root: ${root}.\n` : ''}`
const RECORDS = `Decision records you MUST read before anything else: ${records.join(', ')}.
A record outranks your opinion. An open question or a pending decision in a record is not a closing record.
Never cite a path you have not opened.`
const BRIEF = `${HEAD}Read-only: edit nothing and run nothing.\n${RECORDS}`
// The scribe has to write a file, so it must not be told it is read-only.
const SCRIBE_BRIEF = `${HEAD}You may write exactly one file, the ADR named below, and nothing else. Run nothing.\n${RECORDS}`

// ---- Propose -------------------------------------------------------------------------------------------------
phase('Propose')
const lenses = LENSES.slice(0, N_PROP)
const thunks = lenses.map(l => () => agent(
  `${BRIEF}\n\nYour lens: ${l.text}\nReturn one design under this lens only.`,
  { agentType: AGENT('design-proposer'), label: `propose:${l.key}`, phase: 'Propose', schema: PROPOSAL }))
// The canary is built in the same fan-out. Nothing here reads another node's output, so there is no edge between them.
if (!callerCanary) {
  thunks.push(() => agent(
    `${BRIEF}\n\nBuild ONE deliberately bad proposal that still reads like an honest one. First look in the decision records for an alternative they already REJECTED and write the strongest-sounding proposal for it (canary_basis "rejected_by_record", basis_ref = the record file:line). If the records reject nothing relevant to this decision, write a proposal that violates one hard constraint in a way the title does not give away (canary_basis "violates_hard_constraint", basis_ref = the constraint id and text). Same voice and level of detail as a real proposal; no strawman. Give it a neutral title that does not contain the words canary, rejected or bad.`,
    { agentType: AGENT('design-proposer'), label: 'canary-build', phase: 'Propose', schema: CANARY }))
}
// Barrier: scoring needs every proposal at once, because a juror ranks them against each other.
const got = await parallel(thunks)

const failed_proposers = lenses.filter((l, i) => !got[i]).map(l => l.key)
const real = lenses.map((l, i) => (got[i] ? { ...got[i], lens: l.key, id: `D${i + 1}` } : null)).filter(Boolean)
const canarySrc = callerCanary
  ? { title: callerCanary.title, design: callerCanary.design, rejected_sub_options: callerCanary.rejected_sub_options.map(o => ({ option: String(o && o.option), reason: String(o && o.reason) })),
      riskiest_assumption: callerCanary.riskiest_assumption, cheapest_test: callerCanary.cheapest_test, cost_to_reverse: callerCanary.cost_to_reverse, basis_ref: callerCanary.basis_ref }
  : got[lenses.length]
if (failed_proposers.length) log(`proposers that failed to return: ${failed_proposers.join(', ')}`)
if (!canarySrc || !canarySrc.title || !canarySrc.design) {
  return { error: 'canary_unavailable: the canary proposal could not be built, so the jurors cannot be calibrated; no ADR was written', failed_proposers, caps_applied }
}
if (real.length < 2) {
  return { error: `too_few_proposals: ${real.length} proposal(s) returned, a comparison needs 2; no ADR was written`, failed_proposers, caps_applied }
}
const canaryProposal = { ...canarySrc, id: 'CANARY', lens: 'canary', rejected_sub_options: canarySrc.rejected_sub_options || [] }
const pool = [...real, canaryProposal]

if (budget.total && budget.remaining() < MIN_BUDGET_TO_SCORE) {
  log(`budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left, below ${MIN_BUDGET_TO_SCORE / 1000}k; scoring skipped`)
  return { error: 'budget: scoring skipped, no ADR was written', proposals: real.map(p => ({ id: p.id, lens: p.lens, title: p.title, design: p.design })), failed_proposers, caps_applied }
}

// ---- Score ---------------------------------------------------------------------------------------------------
// Anonymise and reorder in code. Authorship (lens) is stripped; each juror sees its own P1..Pn order, an independent
// shuffle from its own fixed seed (so two jurors can share an order by chance). The seeds are fixed.
const mulberry32 = seed => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const shuffled = (arr, seed) => {
  const a = arr.slice(), rnd = mulberry32(seed)
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
const orders = Array.from({ length: N_JUR }, (_, j) => shuffled(pool, 20261013 + j))

const render = (p, label) =>
  `### ${label}: ${p.title}\nDesign:\n${p.design}\n` +
  `Rejected sub-options: ${p.rejected_sub_options.map(o => `${o.option} (${o.reason})`).join('; ') || 'none stated'}\n` +
  `Riskiest assumption: ${p.riskiest_assumption}\nCheapest test: ${p.cheapest_test}\nCost to reverse: ${p.cost_to_reverse}`

const RUBRIC = `Score every proposal 0-5 on each criterion: ${CRITERIA.join(', ')}. Every score needs a cite: a file:line you opened (a record path with its line counts). A constraint id such as C2 is accepted only as the cite for correctness_vs_constraints. If any criterion of a proposal has no valid cite, the juror's whole score for that proposal is discarded. List any hard-constraint violation separately in hard_constraint_violation (constraint id and why; empty string if none) and set rejected_by_record when a decision record already rejected what the proposal proposes. Return a label for every proposal.`

phase('Score')
// Barrier: the winner is unknown until every juror's scores are in, and the canary check needs all of them.
const jurorOut = await parallel(orders.map((order, j) => () => agent(
  `${BRIEF}\n\n${RUBRIC}\n\nProposals, in the order to read them:\n\n${order.map((p, i) => render(p, `P${i + 1}`)).join('\n\n')}`,
  { agentType: AGENT('design-juror'), label: `juror:${j + 1}`, phase: 'Score', schema: SCORES })))

const jurorsOk = jurorOut.map((r, j) => (r ? j : -1)).filter(j => j >= 0)
const failed_jurors = jurorOut.map((r, j) => (r ? null : j + 1)).filter(Boolean)
if (failed_jurors.length) log(`jurors that failed to return: ${failed_jurors.join(', ')}`)
if (jurorsOk.length < MIN.jurors) {
  return { error: `insufficient_jurors: ${jurorsOk.length} of ${N_JUR} returned, a spread check needs ${MIN.jurors}; no ADR was written`, failed_jurors, failed_proposers, caps_applied }
}

// A cite is checked for form only: a path-like name (a letter and a dot or slash) with a line number, so "12:30" and
// "host:80" fail. A constraint id counts only for correctness_vs_constraints, and only if that constraint exists.
const validCite = (c, k) => {
  if (typeof c !== 'string') return false
  if ([...c.matchAll(/([\w.\/-]+):(\d+)/g)].some(m => /[A-Za-z]/.test(m[1]) && /[.\/]/.test(m[1]) && Number(m[2]) >= 1)) return true
  return k === 'correctness_vs_constraints' && [...c.matchAll(/\bC(\d+)\b/g)].some(m => Number(m[1]) >= 1 && Number(m[1]) <= constraints.length)
}
const stat = {}
pool.forEach(p => { stat[p.id] = { jurors: {} } })
const uncited = [], unscored = [], ignored_labels = []
for (const j of jurorsOk) {
  // Jurors write "P3" in their rationale. P3 is a different proposal for every juror, so swap in the stable id before
  // the text travels. The canary must not be named downstream.
  const unlabel = t => String(t || '').replace(/\bP(\d+)\b/g, (m, n) => { const q = orders[j][Number(n) - 1]; return q ? (q.id === 'CANARY' ? 'another option' : q.id) : m })
  for (const s of jurorOut[j].scores) {
    const m = /^P(\d+)$/.exec(String(s.label).trim())
    const p = m && orders[j][Number(m[1]) - 1]
    if (!p) { log(`juror ${j + 1} returned an unknown label "${s.label}"; ignored`); ignored_labels.push(`juror ${j + 1}: unknown label "${s.label}"`); continue }
    if (stat[p.id].jurors[j]) { log(`juror ${j + 1} scored ${s.label} twice; first kept`); ignored_labels.push(`juror ${j + 1}: ${s.label} (${p.id}) scored twice, first kept`); continue }
    const crit = {}, bad = []
    for (const k of CRITERIA) {
      const c = s.criteria[k]
      if (c && Number.isInteger(c.score) && c.score >= 0 && c.score <= 5 && validCite(c.cite, k)) crit[k] = { score: c.score, cite: c.cite }
      else bad.push(k)
    }
    // A juror who leaves one criterion uncited would otherwise raise the average by dropping its low score, so the whole
    // score for this proposal is discarded. The hard-constraint flags do not depend on cites and are kept.
    if (bad.length) uncited.push(`juror ${j + 1} ${p.id}: ${bad.join(', ')}`)
    const vals = bad.length ? [] : Object.values(crit).map(c => c.score)
    const violation = unlabel(s.hard_constraint_violation).trim()
    stat[p.id].jurors[j] = {
      juror: j + 1, total: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, criteria: bad.length ? {} : crit,
      violation, rejected_by_record: !!s.rejected_by_record, record_ref: s.record_ref || '', flagged: !!violation || !!s.rejected_by_record, rationale: unlabel(s.rationale),
    }
  }
  const skipped = pool.filter(p => !stat[p.id].jurors[j]).map(p => p.id)
  if (skipped.length) { log(`juror ${j + 1} left unscored: ${skipped.join(', ')}`); skipped.forEach(id => unscored.push(`juror ${j + 1} ${id}`)) }
}
if (uncited.length) log(`${uncited.length} score(s) discarded for a missing or malformed cite or an out-of-range value: ${uncited.join('; ')}`)
const dropped = { uncited, unscored, ignored_labels }

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const r2 = x => (x === null ? null : Math.round(x * 100) / 100)
const summarise = p => {
  const js = Object.values(stat[p.id].jurors)
  const totals = js.map(x => x.total).filter(t => t !== null)
  return {
    id: p.id, title: p.title, lens: p.lens, mean: avg(totals), spread: totals.length > 1 ? Math.max(...totals) - Math.min(...totals) : 0, scored_by: totals.length,
    per_juror: js.map(x => ({ juror: x.juror, total: r2(x.total), criteria: x.criteria, violation: x.violation, rejected_by_record: x.rejected_by_record, record_ref: x.record_ref, rationale: x.rationale })),
    criterion_means: Object.fromEntries(CRITERIA.map(k => [k, r2(avg(js.map(x => x.criteria[k]).filter(Boolean).map(c => c.score)))])),
    flagged_by: js.filter(x => x.flagged).length, uncited: uncited.filter(u => u.includes(` ${p.id}:`)).length,
  }
}
const sums = Object.fromEntries(pool.map(p => [p.id, summarise(p)]))

// Canary gate. Every returned juror must flag it, and its mean must not sit above the median of all means.
const means = pool.map(p => sums[p.id].mean).filter(m => m !== null).sort((a, b) => a - b)
const median = means.length % 2 ? means[(means.length - 1) / 2] : (means[means.length / 2 - 1] + means[means.length / 2]) / 2
const cs = sums.CANARY
const canary_not_flagged_by = jurorsOk.filter(j => !(stat.CANARY.jurors[j] && stat.CANARY.jurors[j].flagged)).map(j => j + 1)
const canary_above_median = cs.mean !== null && cs.mean > median
const canary_underscored = cs.scored_by < MIN.jurors
const canaryReport = { basis: canarySrc.canary_basis || 'caller-supplied', basis_ref: canarySrc.basis_ref, mean: r2(cs.mean), median_of_all: r2(median), not_flagged_by: canary_not_flagged_by, above_median: canary_above_median, scored_by: cs.scored_by }
log(`canary: flagged by ${jurorsOk.length - canary_not_flagged_by.length}/${jurorsOk.length} jurors, mean ${canaryReport.mean} vs median ${canaryReport.median_of_all}`)
if (canary_not_flagged_by.length || canary_above_median || canary_underscored) {
  const why = [canary_not_flagged_by.length ? `jurors ${canary_not_flagged_by.join(', ')} did not flag it` : '', canary_above_median ? `it ranked above the median (${canaryReport.mean} > ${canaryReport.median_of_all})` : '', canary_underscored ? `only ${cs.scored_by} juror(s) gave it a valid score, ${MIN.jurors} are needed to check the median` : ''].filter(Boolean).join('; ')
  const msg = `canary_failed: the planted bad proposal got through (${why}). The jurors are not calibrated, so no score is trustworthy and no ADR was written.`
  log(msg)
  return { error: msg, status: 'canary_failed', canary: canaryReport, ...dropped, failed_jurors, failed_proposers, caps_applied }
}

// ---- Rank and spread check, all in code ------------------------------------------------------------------------
const table = real.map(p => {
  const s = sums[p.id]
  return { ...s, disqualified: s.flagged_by * 2 > jurorsOk.length, contested: s.flagged_by > 0 && s.flagged_by * 2 <= jurorsOk.length,
    // Fewer than MIN.jurors valid scores: a one-juror mean has spread 0 and would slip past the spread check, so it is not ranked.
    underscored: s.scored_by < MIN.jurors }
})
const byMean = (a, b) => (b.mean - a.mean) || a.id.localeCompare(b.id)
const eligible = table.filter(t => !t.disqualified && !t.underscored).sort(byMean)
const disqualified = table.filter(t => t.disqualified).map(t => ({ id: t.id, title: t.title, flagged_by: t.flagged_by, reasons: t.per_juror.filter(x => x.violation || x.rejected_by_record).map(x => `juror ${x.juror}: ${x.violation || 'rejected by record'}${x.record_ref ? ` (${x.record_ref})` : ''}`) }))
const common = { canary: canaryReport, score_table: table.map(t => ({ id: t.id, title: t.title, mean: r2(t.mean), spread: r2(t.spread), scored_by: t.scored_by, underscored: t.underscored, criterion_means: t.criterion_means, disqualified: t.disqualified, contested: t.contested })), disqualified, uncited_scores: uncited.length, ...dropped, failed_proposers, failed_jurors, caps_applied }
log(`ranking: ${eligible.map(t => `${t.id} ${r2(t.mean)}`).join(', ') || 'none'}; disqualified: ${disqualified.map(d => d.id).join(', ') || 'none'}`)

if (!eligible.length) {
  const msg = `no_viable_design: every proposal was disqualified or scored by fewer than ${MIN.jurors} jurors; nothing to record. Loosen the constraints or rerun with different lenses.`
  log(msg)
  return { ...common, status: 'no_viable_design', error: msg }
}
const [top, second] = eligible
const margin = second ? top.mean - second.mean : null
const unclear = (second && margin <= 0.5) || top.spread > 1.5
if (unclear) {
  const reason = [second && margin <= 0.5 ? `top two within ${r2(margin)} point (limit 0.5)` : '', top.spread > 1.5 ? `juror spread ${r2(top.spread)} on the leader (limit 1.5)` : ''].filter(Boolean).join('; ')
  log(`no clear winner: ${reason}. No ADR is written; both finalists are returned with the dissent.`)
  const finalist = t => ({ ...t, design: real.find(p => p.id === t.id) })
  return { ...common, status: 'no_clear_winner', reason, finalists: [top, second].filter(Boolean).map(finalist) }
}

// ---- Record --------------------------------------------------------------------------------------------------
phase('Record')
if (budget.total && budget.remaining() < MIN_BUDGET_TO_RECORD) {
  log(`budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left, below ${MIN_BUDGET_TO_RECORD / 1000}k; ADR skipped`)
  return { ...common, status: 'adr_skipped_budget', winner: top.id, error: 'budget: the ADR was not written' }
}
const rows = table.slice().sort((a, b) => (a.disqualified - b.disqualified) || (a.underscored - b.underscored) || byMean(a, b))
const scoreTable = rows.map(t => ({ option: `${t.id}: ${t.title}`, mean: r2(t.mean), juror_spread: r2(t.spread), criterion_means: t.criterion_means, disqualified: t.disqualified, ranked: !t.underscored }))
const designOf = id => real.find(p => p.id === id)
const optionText = t => {
  const p = designOf(t.id)
  return `## ${t.id}: ${t.title} (mean ${r2(t.mean)}, spread ${r2(t.spread)}${t.disqualified ? ', DISQUALIFIED' : ''}${t.underscored ? `, NOT RANKED: only ${t.scored_by} juror(s) gave a valid score` : ''}${t.contested ? ', contested hard-constraint flag' : ''})\n` +
    `Design:\n${p.design}\nRejected sub-options: ${p.rejected_sub_options.map(o => `${o.option} (${o.reason})`).join('; ') || 'none stated'}\n` +
    `Riskiest assumption: ${p.riskiest_assumption}\nCheapest test: ${p.cheapest_test}\nCost to reverse: ${p.cost_to_reverse}\n` +
    `Juror notes:\n${t.per_juror.map(x => `- juror ${x.juror} (total ${x.total}): ${x.rationale}${x.violation ? ` | violation: ${x.violation}` : ''}${x.rejected_by_record ? ` | rejected by record ${x.record_ref}` : ''}`).join('\n')}`
}
const MATERIAL = `${SCRIBE_BRIEF}

The comparison is finished. You may not add an option, drop one, re-rank, or change a number.
WINNER: ${top.id}. Margin over the runner-up: ${second ? `${r2(margin)} points` : 'no eligible runner-up'}.
${table.some(t => t.contested && t.id === top.id) ? 'The winner carries a contested hard-constraint flag from a minority of jurors: put it under Risks and open dissent.\n' : ''}
${table.some(t => t.underscored) ? 'An option marked NOT RANKED was left out of the ranking because too few jurors gave it a valid score; say so under Options considered and do not present its mean as a result.\n' : ''}SCORE TABLE (copy exactly):
${JSON.stringify(scoreTable, null, 1)}

OPTIONS (winner first):
${[top, ...rows.filter(t => t.id !== top.id)].map(optionText).join('\n\n')}`

const draftPath = n => `${adrPath.replace(/\.md$/, '')}.r${n}.md`
const rounds = []
let prev = null
for (let r = 1; r <= MAX_ROUNDS; r++) {
  const path = draftPath(r)
  const scribePrompt = r === 1
    ? `${MATERIAL}\n\nWrite the ADR to ${path}.`
    : `${MATERIAL}\n\nRevise the draft at ${prev.path}. Write the revised ADR to ${path}. Fix exactly these critic failures and change nothing else:\n${prev.failures.map(f => `- [${f.check}] ${f.detail}`).join('\n')}`
  const sc = await agent(scribePrompt, { agentType: AGENT('adr-scribe'), label: `scribe:r${r}`, phase: 'Record', schema: SCRIBE })
  if (!sc) { rounds.push({ round: r, path, verdict: 'SCRIBE_FAILED', failures: null }); log(`scribe round ${r} failed to return`); break }
  if (sc.path !== path) log(`scribe wrote to ${sc.path}, asked for ${path}; the critic reads ${path}`)
  const cr = await agent(
    `${BRIEF}\n\nCheck the ADR at ${path}. The score table it must match, number for number:\n${JSON.stringify(scoreTable, null, 1)}\n` +
    `Juror dissent and contested flags that must appear:\n${table.filter(t => t.contested || t.spread > 1).map(t => `${t.id}: ${t.per_juror.map(x => `juror ${x.juror}: ${x.rationale}${x.violation ? ` | ${x.violation}` : ''}`).join(' / ')}`).join('\n') || '(none)'}`,
    { agentType: AGENT('adr-critic'), label: `critic:r${r}`, phase: 'Record', schema: CRITIC })
  if (!cr) { rounds.push({ round: r, path, verdict: 'CRITIC_FAILED', failures: null, notes: sc.notes }); log(`critic round ${r} failed to return; the draft is unchecked`); break }
  // PASS with a non-empty failure list is not a pass; FAIL with no reasons is still a fail.
  const failures = cr.failures.length ? cr.failures : cr.verdict === 'FAIL' ? [{ check: 'other', detail: 'critic returned FAIL without naming a failure' }] : []
  rounds.push({ round: r, path, verdict: failures.length ? 'FAIL' : 'PASS', failures, notes: sc.notes })
  log(`round ${r}: ${failures.length ? `FAIL (${failures.length}): ${failures.map(f => f.check).join(', ')}` : 'PASS'}`)
  if (!failures.length) break
  prev = { path, failures }
}

const checked = rounds.filter(x => x.failures)
const best = checked.length ? checked.reduce((b, x) => (x.failures.length <= b.failures.length ? x : b)) : null
const last = rounds[rounds.length - 1]
const regressed = !!best && checked[checked.length - 1] !== best
let status = 'adr_unchecked'
if (best) status = best.failures.length ? 'adr_open_objections' : 'adr_written'
if (status === 'adr_open_objections') log(`stopped after ${rounds.length} round(s) with ${best.failures.length} open objection(s); returning the best draft (round ${best.round})`)
if (regressed) log(`a later round was worse; the best draft is round ${best.round}, not the last`)
const finalPath = best ? best.path : last && last.verdict !== 'SCRIBE_FAILED' ? last.path : null
if (!finalPath) return { ...common, status: 'adr_failed', error: 'the scribe never returned a draft; the comparison result is in score_table', winner: top.id, rounds }

return {
  ...common,
  status,
  winner: { id: top.id, title: top.title, mean: r2(top.mean), margin: margin === null ? null : r2(margin), spread: r2(top.spread) },
  adr: { path: finalPath, verdict: best ? (best.failures.length ? 'FAIL' : 'PASS') : 'UNCHECKED', open_objections: best ? best.failures : null, best_round: best ? best.round : null, regressed, drafts: rounds.map(x => x.path) },
  rounds,
}
