export const meta = {
  name: 'hypothesis-duel',
  description: 'Debug a defect with unknown cause by competing hypotheses: one investigator per hypothesis states a falsifiable prediction, blind cross-examiners try to kill each one with all the evidence, a failing repro test is written for the best survivor, one builder fixes it in a worktree and a read-only critic reviews it (3 rounds at most). A planted decoy hypothesis proves the cross-examiners can refute.',
  phases: [
    { title: 'Hypotheses', detail: 'dedupe the caller hypotheses (max 5), enumerate if fewer than 2, plant one decoy' },
    { title: 'Investigate', detail: 'one investigator per hypothesis, each with a falsifiable prediction' },
    { title: 'Cross-examine', detail: 'one blind examiner per hypothesis with all the evidence, then one re-investigation round for UNDERDETERMINED' },
    { title: 'Repro', detail: 'a failing test for the top survivor, shown failing before any fix' },
    { title: 'Fix', detail: 'one builder in a worktree, then a read-only critic, 3 rounds at most' },
  ],
}

// args: { symptom: "<what is wrong>", root: "<repo path>", repro?: "<read-only command that shows it>", logs?: ["<paths or excerpts>"],
//         records?: ["<decision record paths>"], hypotheses?: ["<claim>" | {claim, suspect}], decoy?: {claim, suspect?, contradicting_fact},
//         maxHypotheses?: n, maxBash?: n, maxRounds?: n, maxRetries?: n, agentPrefix?: "agent-teams:" }
// A JSON string is accepted and parsed. Caller values can only LOWER the caps below, never raise them (a value below a minimum is clamped up to it and reported in warnings).
// At least one of repro or logs is needed: with nothing to observe, nothing can be falsified.
// agentPrefix goes in front of each agent name. The default fits a plugin install; pass "" for bare agent names
// (symlinks into ~/.claude/agents, or --plugin-dir).
// Launch from inside the project repository: the test writer and the builder get worktrees cut from the session's working directory.
// The runtime has no clock, so the wall-clock limit belongs to the caller, for example `timeout 3600 claude -p ...`.

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { return { error: 'args is a string that is not valid JSON (' + e.message + '); nothing ran' } }
}
if (!input || typeof input !== 'object' || typeof input.symptom !== 'string' || !input.symptom.trim() ||
    typeof input.root !== 'string' || !input.root.trim()) {
  return { error: 'hypothesis-duel needs args {symptom, root, repro? | logs?, records?, hypotheses?, decoy?, ...caps}; nothing ran' }
}
const asList = v => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
const symptom = input.symptom.trim()
const root = input.root.trim().replace(/\/+$/, '')
const repro = typeof input.repro === 'string' ? input.repro.trim() : ''
const logs = asList(input.logs)
const records = asList(input.records)
if (!repro && !logs.length) return { error: 'needs an observable: pass repro (a command) or logs (paths or excerpts); nothing ran' }

// Hard ceilings live here, in code. A caller value is clamped into [min, hard]; a value that is not an integer falls back to hard.
// Both cases are reported in warnings, so a typo never silently runs a bigger or smaller job than asked for.
const warnings = []
const HARD = { hyp: 5, rounds: 3, retries: 2, tests: 2, bash: 12, agents: 40 }
const cap = (name, v, hard, min) => {
  if (v === undefined) return hard
  const n = Number.isInteger(v) ? Math.max(min, Math.min(v, hard)) : hard
  if (n !== v) warnings.push(`${name}=${JSON.stringify(v)} is outside ${min}..${hard} or not an integer; ran with ${n}`)
  return n
}
const MAX_HYP = cap('maxHypotheses', input.maxHypotheses, HARD.hyp, 2)
const MAX_BASH = cap('maxBash', input.maxBash, HARD.bash, 1)
const MAX_ROUNDS = cap('maxRounds', input.maxRounds, HARD.rounds, 1)
const MAX_RETRIES = cap('maxRetries', input.maxRetries, HARD.retries, 0)
const MAX_TESTS = HARD.tests
const MIN_BUDGET_TO_FIX = 150000
warnings.forEach(w => log(w))
log(`caps: hypotheses ${MAX_HYP}, bash per investigator ${MAX_BASH}, cross-exam rounds 1 + 1 re-investigation, repro tries ${MAX_TESTS}, fix retries ${MAX_RETRIES}, critic rounds ${MAX_ROUNDS}, agents ${HARD.agents}`)

const PREFIX = input.agentPrefix !== undefined ? input.agentPrefix : 'agent-teams:'
if (typeof PREFIX !== 'string') return { error: 'agentPrefix must be a string ("" for bare agent names); nothing ran' }
const AGENT = name => PREFIX + name

let spawned = 0
const failed_stages = []
const dropped = []
const cap_violations = []
const drop = (what, why) => { dropped.push({ what, why }); log(`dropped: ${what} (${why})`) }
async function spawn(prompt, opts) {
  if (spawned >= HARD.agents) {
    failed_stages.push({ stage: opts.phase, id: opts.label, why: `agent cap ${HARD.agents} reached` })
    log(`agent cap ${HARD.agents} reached; skipped ${opts.label}`)
    return null
  }
  spawned++
  try {
    const out = await agent(prompt, opts)
    if (!out) failed_stages.push({ stage: opts.phase, id: opts.label, why: 'agent returned nothing' })
    return out
  } catch (e) {
    failed_stages.push({ stage: opts.phase, id: opts.label, why: 'threw: ' + e.message })
    return null
  }
}
const clipped = new Set()   // clip() runs again on every render of the same evidence; report each item once
const clip = (s, n, what) => {
  s = String(s ?? '')
  if (s.length <= n) return s
  if (!clipped.has(what)) { clipped.add(what); drop(`${s.length - n} chars of ${what}`, `clipped to ${n} chars`) }
  return s.slice(0, n) + `\n[clipped: ${s.length - n} more chars]`
}

const BRIEF = [
  `Defect in ${root}. Symptom: ${symptom}`,
  repro ? `Repro command (safe to run, it only observes): ${repro}` : '',
  logs.length ? `Logs and other evidence: ${logs.join(', ')}` : '',
  `Decision records you MUST read before reporting anything: ${records.length ? records.join(', ') : '(none listed: search the repository for intent, ADR, troubleshooting and handoff files and say which you found)'}. A hypothesis a record already rejected is not new.`,
  'Never edit the repository, push, or touch anything outside it.',
].filter(Boolean).join('\n')

const CASE = {
  type: 'object',
  properties: {
    hypothesis_id: { type: 'string' },
    prediction: { type: 'string' },
    falsifier: { type: 'string' },
    experiment: { type: 'string' },
    commands_run: { type: 'array', items: { type: 'string' } },
    observation: { type: 'string' },
    supports: { type: 'string', enum: ['supports', 'contradicts', 'inconclusive'] },
    files_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['hypothesis_id', 'prediction', 'falsifier', 'experiment', 'commands_run', 'observation', 'supports', 'files_read'],
}
const HYP = {
  type: 'object',
  properties: { claim: { type: 'string' }, suspect: { type: 'string' } },
  required: ['claim'],
}
const SCOUT = {
  type: 'object',
  properties: {
    hypotheses: { type: 'array', items: HYP },
    decoy: {
      type: 'object',
      properties: { claim: { type: 'string' }, suspect: { type: 'string' }, contradicting_fact: { type: 'string' } },
      required: ['claim', 'contradicting_fact'],
    },
    files_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['hypotheses', 'files_read'],
}
const EXAM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['SURVIVES', 'REFUTED', 'UNDERDETERMINED'] },
    strongest_alternative: { type: 'string' },
    alternative_strength: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
    deciding_observation: { type: 'string' },
    reason: { type: 'string' },
    opened: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'verdict', 'strongest_alternative', 'alternative_strength', 'deciding_observation', 'reason', 'opened'],
}
const TEST = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['written', 'declined'] },
    worktree_path: { type: 'string' },
    test_command: { type: 'string' },
    test_files: { type: 'array', items: { type: 'string' } },
    test_diff: { type: 'string' },
    red_output: { type: 'string' },
    failure_quote: { type: 'string' },
    fails_for_predicted_reason: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['status', 'worktree_path', 'test_command', 'test_files', 'test_diff', 'red_output', 'failure_quote', 'fails_for_predicted_reason', 'notes'],
}
const BUILD = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['patched', 'declined'] },
    worktree_path: { type: 'string' },
    branch: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    test_command: { type: 'string' },
    red_output: { type: 'string' },
    green_output: { type: 'string' },
    tests_pass: { type: 'boolean' },
    diff: { type: 'string' },
    notes: { type: 'string' },
    objection_replies: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'worktree_path', 'files_changed', 'test_command', 'red_output', 'green_output', 'tests_pass', 'diff', 'notes', 'objection_replies'],
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
          check: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          needs: { type: 'string' },
        },
        required: ['check', 'severity', 'problem'],
      },
    },
    opened: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'failures', 'opened', 'notes'],
}

// ---------------------------------------------------------------- Hypotheses
phase('Hypotheses')
// Dedupe in code: same words in any order and case is the same claim. Unicode-aware, so non-English claims do not collapse.
const keyOf = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ')
const asHyp = h => {
  if (typeof h === 'string') return h.trim() ? { claim: h.trim(), suspect: '' } : null
  if (h && typeof h.claim === 'string' && h.claim.trim()) return { claim: h.claim.trim(), suspect: typeof h.suspect === 'string' ? h.suspect.trim() : '' }
  return null
}
function dedupe(list, seen) {
  const kept = []
  for (const h of list.map(asHyp).filter(Boolean)) {
    const k = keyOf(h.claim)
    if (!k || seen.has(k)) { log(`dedupe merged "${h.claim}"`); continue }
    seen.add(k)
    kept.push(h)
  }
  return kept
}
const seenKeys = new Set()
let hyps = dedupe(Array.isArray(input.hypotheses) ? input.hypotheses : [], seenKeys)
let decoy = input.decoy && typeof input.decoy.claim === 'string' && input.decoy.claim.trim() && typeof input.decoy.contradicting_fact === 'string'
  ? { claim: input.decoy.claim.trim(), suspect: typeof input.decoy.suspect === 'string' ? input.decoy.suspect.trim() : '', contradicting_fact: input.decoy.contradicting_fact.trim() }
  : null

const want = hyps.length >= 2 ? 0 : 3 - hyps.length
if (want > 0 || !decoy) {
  const scout = await spawn(
    `${BRIEF}\n\nMode: enumerate.\n` +
    (want > 0 ? `Propose ${want} distinct, credible hypotheses for the cause, each with a suspect location (file:line or component). Already proposed: ${hyps.map(h => `"${h.claim}"`).join('; ') || '(none)'}. Do not repeat them.\n` : 'Return an empty hypotheses array: the caller already has enough.\n') +
    (decoy ? '' : 'Also write ONE decoy hypothesis in the same style as the others: plausible to a careless reader but already ruled out by a fact in the supplied evidence (for example the failing path never touches the component it blames). Put the ruling-out fact in contradicting_fact with file:line or the log line.'),
    { agentType: AGENT('bug-hypothesis-investigator'), label: 'enumerate', phase: 'Hypotheses', schema: SCOUT })
  if (scout) {
    hyps = hyps.concat(dedupe(scout.hypotheses, seenKeys))
    if (!decoy && scout.decoy) {
      const k = keyOf(scout.decoy.claim)
      if (k && !seenKeys.has(k)) { seenKeys.add(k); decoy = { suspect: '', ...scout.decoy } }
      else log('scout decoy duplicates a real hypothesis; dropped, so this run has no canary')
    }
  }
}
for (const h of hyps.slice(MAX_HYP)) drop(`hypothesis "${h.claim}"`, `hypothesis cap ${MAX_HYP}`)
hyps = hyps.slice(0, MAX_HYP)
if (hyps.length < 2) {
  return { error: 'fewer than 2 distinct hypotheses after dedupe; a single obvious cause needs a plain debugger, not a duel. Nothing was investigated.', hypotheses: hyps, dropped, failed_stages }
}
if (!decoy) { warnings.push('no decoy could be planted: the cross-examiners are uncalibrated, treat REFUTED and SURVIVES as unchecked'); log(warnings[0]) }

// The decoy goes in at a position derived from the symptom text, so it is not always last and the run stays deterministic.
const entries = hyps.map(h => ({ ...h, decoy: false }))
if (decoy) entries.splice(symptom.length % (entries.length + 1), 0, { claim: decoy.claim, suspect: decoy.suspect, decoy: true, contradicting_fact: decoy.contradicting_fact })
entries.forEach((e, i) => { e.id = `H${i + 1}`; e.idx = i })
log(`hypotheses: ${entries.map(e => e.id).join(', ')} (${hyps.length} real${decoy ? ' + 1 decoy' : ''})`)

const caseOf = e => e.case2 || e.case
const finalOf = e => e.v2 || e.v1
const checkCap = (e, c) => {
  if (c && c.commands_run.length > MAX_BASH) {
    cap_violations.push({ id: e.id, commands: c.commands_run.length, cap: MAX_BASH })
    log(`${e.id}: investigator ran ${c.commands_run.length} commands, over the cap of ${MAX_BASH}; case kept, violation reported`)
  }
}

// ---------------------------------------------------------------- Investigate
phase('Investigate')
const investigatePrompt = e =>
  `${BRIEF}\n\nMode: investigate. Hypothesis ${e.id}: ${e.claim}${e.suspect ? `\nWhere it points: ${e.suspect}` : ''}\n` +
  `State a PREDICTION that would falsify it ("if ${e.id} is true then X will appear in <log, test or output>"), say what observation would falsify it, then run the cheapest experiment that can show X present or absent. ` +
  `Quote the observed output verbatim in observation. Run at most ${MAX_BASH} shell commands and list every one in commands_run. Return hypothesis_id "${e.id}".`
// BARRIER: the cross-examiners attack each hypothesis with the OTHER hypotheses' evidence, so every case must exist first.
const cases = await parallel(entries.map(e => () => spawn(investigatePrompt(e),
  { agentType: AGENT('bug-hypothesis-investigator'), label: `investigate:${e.id}`, phase: 'Investigate', schema: CASE })))
entries.forEach((e, i) => { e.case = cases[i]; checkCap(e, e.case) })
log(`investigated ${entries.filter(e => e.case).length}/${entries.length}`)

// ---------------------------------------------------------------- Cross-examine
phase('Cross-examine')
// All raw evidence, verbatim, labelled by hypothesis id only. The examiner is never told who wrote a case or which hypothesis is the decoy.
const render = (e, c) =>
  `--- ${e.id}: ${e.claim}\nprediction: ${c.prediction}\nwould be falsified by: ${c.falsifier}\nexperiment: ${c.experiment}\n` +
  `commands: ${c.commands_run.join(' ; ') || '(none)'}\nobserved (verbatim):\n${clip(c.observation, 4000, `${e.id} observation`)}`
const bundle = (id, c) => entries.filter(x => (x.id === id ? c : x.case)).map(x => render(x, x.id === id ? c : x.case)).join('\n\n')
const examPrompt = (e, c, round) =>
  `${BRIEF}\n\nCross-examine hypothesis ${e.id}: "${e.claim}" (round ${round}). Its case was written by an author you do not know.\n\n` +
  `All evidence gathered for all hypotheses:\n${bundle(e.id, c)}\n\n` +
  `Find the strongest alternative explanation of the SAME evidence (another listed hypothesis or one of your own) and decide. Return id "${e.id}".`
// settle() may downgrade a SURVIVES, so it keeps the examiner's own word in raw_verdict. The canary reads raw_verdict:
// an honest investigator marks the decoy `contradicts`, and a downgrade on that label must not hide a rubber-stamping examiner.
const settle = (c, v) => {
  if (!v) return { id: '', verdict: 'NO_VERDICT', reason: 'cross-examiner failed', strongest_alternative: '', alternative_strength: 'strong', deciding_observation: '' }
  const raw = { ...v, raw_verdict: v.verdict }
  // A SURVIVES the author's own result contradicted is inconsistent; it cannot ship a fix.
  if (v.verdict === 'SURVIVES' && c.supports === 'contradicts') {
    return { ...raw, verdict: 'UNDERDETERMINED', reason: `inconsistent: the investigator's own observation contradicted its prediction. ${v.reason}` }
  }
  // SURVIVES is defined as "no alternative explains the evidence as well"; a strong alternative left standing is not that.
  if (v.verdict === 'SURVIVES' && v.alternative_strength === 'strong') {
    return { ...raw, verdict: 'UNDERDETERMINED', reason: `a strong alternative is still unresolved (${v.strongest_alternative}). ${v.reason}` }
  }
  return raw
}
const examinable = entries.filter(e => e.case)
const r1 = await pipeline(examinable, e => spawn(examPrompt(e, e.case, 1),
  { agentType: AGENT('hypothesis-cross-examiner'), label: `exam:${e.id}`, phase: 'Cross-examine', schema: EXAM }))
examinable.forEach((e, i) => { e.v1 = settle(e.case, r1[i]) })
entries.filter(e => !e.case).forEach(e => { e.v1 = { verdict: 'NOT_INVESTIGATED', reason: 'investigator failed', strongest_alternative: '', alternative_strength: 'strong', deciding_observation: '' } })

const canaryOf = () => {
  const d = entries.find(e => e.decoy)
  if (!d) return { state: 'none', note: 'no decoy was planted' }
  const f = finalOf(d) || {}
  const verdict = f.raw_verdict || f.verdict || 'NOT_RUN'
  const state = verdict === 'REFUTED' ? 'caught' : verdict === 'SURVIVES' ? 'failed' : verdict === 'UNDERDETERMINED' ? 'weak' : 'uncalibrated'
  return { state, id: d.id, claim: d.claim, contradicting_fact: d.contradicting_fact, verdict }
}
const snap = () => {
  const real = entries.filter(e => !e.decoy)
  const hypotheses = real.map(e => {
    const c = caseOf(e) || {}, v = finalOf(e) || {}
    return {
      id: e.id, claim: e.claim, suspect: e.suspect, prediction: c.prediction ?? null, falsifier: c.falsifier ?? null, observation: c.observation ?? null,
      author_reading: c.supports ?? null, verdict: v.verdict ?? 'NOT_RUN', strongest_alternative: v.strongest_alternative ?? null,
      alternative_strength: v.alternative_strength ?? null, deciding_observation: v.deciding_observation ?? null, reason: v.reason ?? null, exam_rounds: e.v2 ? 2 : e.v1 ? 1 : 0,
    }
  })
  const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 240)
  const table = ['| id | hypothesis | prediction | observation | verdict | what decides it |', '|---|---|---|---|---|---|']
    .concat(hypotheses.map(h => `| ${h.id} | ${cell(h.claim)} | ${cell(h.prediction)} | ${cell(h.observation)} | ${h.verdict} | ${cell(h.deciding_observation)} |`)).join('\n')
  return { table, hypotheses, canary: canaryOf(), dropped, cap_violations, failed_stages, warnings, agents_spawned: spawned }
}
const canaryFailed = () => {
  const c = canaryOf()
  const error = `canary_failed: the cross-examiner called the decoy ${c.id} ("${c.claim}") ${c.verdict}, but the evidence contradicts it (${c.contradicting_fact}). The examiners are rubber-stamping; none of this run's verdicts can be trusted and no fix was attempted.`
  log(error)
  return { error, canary_failed: true, ...snap() }
}
if (canaryOf().state === 'failed') return canaryFailed()

// One re-investigation round, only for UNDERDETERMINED. No barrier: each re-examination reads the round-1 evidence plus its own new case.
const und = entries.filter(e => e.v1.verdict === 'UNDERDETERMINED' && e.case)
if (und.length) {
  log(`re-investigating ${und.length} UNDERDETERMINED: ${und.map(e => e.id).join(', ')}`)
  const r2 = await pipeline(und,
    e => spawn(
      `${BRIEF}\n\nMode: re-investigate. Hypothesis ${e.id}: ${e.claim}\nThe cross-examiner could not decide. Strongest alternative it named: ${e.v1.strongest_alternative}\n` +
      `Observation that would decide it: ${e.v1.deciding_observation}\nYour earlier case:\n${render(e, e.case)}\n` +
      `Run the experiment that produces that deciding observation (at most ${MAX_BASH} shell commands) and return a fresh case, hypothesis_id "${e.id}".`,
      { agentType: AGENT('bug-hypothesis-investigator'), label: `reinvestigate:${e.id}`, phase: 'Cross-examine', schema: CASE }),
    (c2, e) => (c2
      ? spawn(examPrompt(e, c2, 2), { agentType: AGENT('hypothesis-cross-examiner'), label: `reexam:${e.id}`, phase: 'Cross-examine', schema: EXAM }).then(v => ({ c2, v }))
      : null))
  und.forEach((e, i) => {
    if (!r2[i]) return
    e.case2 = r2[i].c2
    checkCap(e, e.case2)
    e.v2 = settle(e.case2, r2[i].v)
  })
}
if (canaryOf().state === 'failed') return canaryFailed()
const canary = canaryOf()
if (canary.state !== 'caught') { const w = `canary ${canary.state}: the decoy verdict was ${canary.verdict}; treat the verdicts as less trustworthy`; warnings.push(w); log(w) }

const ALT = { weak: 0, moderate: 1, strong: 2 }
const SUP = { supports: 0, inconclusive: 1, contradicts: 2 }
const survivors = entries.filter(e => !e.decoy && finalOf(e).verdict === 'SURVIVES')
  .sort((a, b) => ALT[finalOf(a).alternative_strength] - ALT[finalOf(b).alternative_strength] || SUP[caseOf(a).supports] - SUP[caseOf(b).supports] || a.idx - b.idx)
const underdetermined = entries.filter(e => !e.decoy && finalOf(e).verdict === 'UNDERDETERMINED')
log(`verdicts: ${entries.filter(e => !e.decoy).map(e => `${e.id} ${finalOf(e).verdict}`).join(', ')}; canary ${canary.state}`)

if (!survivors.length) {
  const msg = underdetermined.length
    ? `root cause not established: ${underdetermined.length} hypothesis(es) stayed UNDERDETERMINED after the re-investigation round and none survived. No fix is shipped for an undecided cause; run the deciding observations listed in the table.`
    : 'root cause not established: every hypothesis was refuted or could not be examined. The refutation record is in the table.'
  log(msg)
  return { status: 'root_cause_not_established', message: msg, ...snap() }
}
const top = survivors[0]
const others = survivors.slice(1).map(e => ({ id: e.id, claim: e.claim }))
if (others.length) log(`${others.length} other survivor(s) not fixed: ${others.map(o => o.id).join(', ')}; the top-ranked one is ${top.id}`)

const refutedList = entries.filter(e => !e.decoy && finalOf(e).verdict === 'REFUTED')
  .map(e => `- ${e.id}: ${e.claim} (ruled out by: ${finalOf(e).deciding_observation})`).join('\n') || '(none)'
const undecidedList = underdetermined.map(e => `- ${e.id}: ${e.claim} (undecided; deciding observation: ${finalOf(e).deciding_observation})`).join('\n') || '(none)'
const survivorBrief = `Surviving cause ${top.id}: ${top.claim}${top.suspect ? ` (at ${top.suspect})` : ''}\nIts prediction: ${caseOf(top).prediction}\nObserved: ${clip(caseOf(top).observation, 2000, 'survivor observation')}\n` +
  `Strongest alternative the examiner could not rule out: ${finalOf(top).strongest_alternative}\nRefuted, do NOT fix these:\n${refutedList}\nNot refuted either, still undecided (do not assume they are ruled out; keep the fix from depending on them being false):\n${undecidedList}`

if (budget.total && budget.remaining() < MIN_BUDGET_TO_FIX) {
  const msg = `budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left, below ${MIN_BUDGET_TO_FIX / 1000}k; the cause is established but no repro test or fix was attempted`
  log(msg)
  return { status: 'cause_established_fix_skipped', message: msg, survivor: { id: top.id, claim: top.claim }, other_survivors: others, ...snap() }
}

// ---------------------------------------------------------------- Repro
phase('Repro')
const TEST_RE = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.\w+$|(^|\/)test_[^/]*$|_test\.\w+$/i
const UNSAFE = /\bgit\s+(push|commit|remote|fetch)\b|\b(ssh|scp|rsync|kubectl|terraform\s+apply|docker\s+push|npm\s+publish|helm\s+(install|upgrade))\b|\bcurl\b[^|;]*\|\s*(ba)?sh\b|\brm\s+-rf?\s+\//
const SKIP_RE = /(@pytest\.mark\.(skip|xfail)|\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bt\.Skip\(|@Ignore\b|@Disabled\b|\bpytest\.skip\()/
const diffLines = (diff, sign) => {
  const out = []
  let file = ''
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue }
    if (l.startsWith('--- ')) continue
    if (l.startsWith(sign)) out.push({ file, text: l.slice(1) })
  }
  return out
}

// isolation:'worktree' can fail silently, and then the agent edits the real checkout. The path is self-reported, but a path equal to root is a certain failure.
const badWorktree = p => typeof p !== 'string' || !p.startsWith('/') || p.replace(/\/+$/, '') === root
const ISOLATION = 'isolation: no absolute worktree path distinct from the original checkout was reported, so the agent may have edited the real checkout'
function testGateError(w) {
  if (badWorktree(w.worktree_path)) return ISOLATION
  if (!w.red_output.trim()) return 'no failing output: a repro test that was never seen failing proves nothing'
  if (!w.failure_quote.trim() || !w.red_output.includes(w.failure_quote)) return 'failure_quote is empty or not a verbatim part of red_output'
  if (!w.fails_for_predicted_reason) return 'the test does not fail for the predicted reason'
  if (!w.test_diff.trim() || !w.test_files.length) return 'empty test diff'
  if (w.test_files.some(p => !TEST_RE.test(p))) return 'the writer changed a file that is not a test file'
  if (diffLines(w.test_diff, '-').length) return 'the test diff removes lines; a repro test may only add'
  if (UNSAFE.test(w.test_command)) return 'test command looks like it could push, deploy or reach a remote machine'
  return ''
}
let reproTest = null
let lastGate = ''
const reproHistory = []
for (let t = 1; t <= MAX_TESTS && !reproTest; t++) {
  const w = await spawn(
    `${BRIEF}\n\nWrite ONE failing test for the surviving cause, in your own worktree. Do not fix anything.\n${survivorBrief}\n` +
    `Run it and show it failing for the reason the prediction names. Try ${t} of ${MAX_TESTS}.` +
    (lastGate ? `\nYour previous try was rejected: ${lastGate}` : ''),
    { agentType: AGENT('repro-test-writer'), isolation: 'worktree', label: `repro:t${t}`, phase: 'Repro', schema: TEST })
  if (!w) { reproHistory.push({ try: t, result: 'writer failed' }); break }
  if (w.status === 'declined') { reproHistory.push({ try: t, result: 'declined: ' + w.notes }); break }
  lastGate = testGateError(w)
  reproHistory.push({ try: t, result: lastGate ? 'gate: ' + lastGate : 'accepted' })
  if (lastGate === ISOLATION) { warnings.push(`${ISOLATION}; run git status in ${root}`); break } // a retry would repeat the damage
  if (!lastGate) reproTest = w
}
if (!reproTest) {
  const msg = `repro_not_established: no accepted failing test for ${top.id} (${reproHistory.map(h => h.result).join('; ')}). The cause is established but no fix is attempted without a test that fails first.`
  log(msg)
  return { status: 'repro_not_established', message: msg, survivor: { id: top.id, claim: top.claim }, other_survivors: others, repro_history: reproHistory, ...snap() }
}

// ---------------------------------------------------------------- Fix
phase('Fix')
const testAdds = diffLines(reproTest.test_diff, '+').map(l => l.text.trim()).filter(Boolean)
function gateError(b) {
  if (b.status !== 'patched') return 'builder did not report a patch'
  if (badWorktree(b.worktree_path)) return ISOLATION
  if (!b.tests_pass) return 'builder did not observe the tests passing'
  if (!b.red_output.trim()) return 'no failing-before output'
  if (!b.green_output.trim()) return 'no passing-after output'
  if (!b.diff.trim()) return 'empty diff'
  if (UNSAFE.test(b.test_command)) return 'test command looks like it could push, deploy or reach a remote machine'
  if (b.files_changed.some(p => p.startsWith('/') && !p.startsWith(b.worktree_path + '/'))) return 'edit outside the worktree'
  if (!b.files_changed.some(p => !TEST_RE.test(p))) return 'no source file changed: only tests were touched'
  const inTests = l => TEST_RE.test(l.file)
  if (diffLines(b.diff, '-').some(inTests)) return 'lines were removed or changed in a test file; tests may only be added'
  if (diffLines(b.diff, '+').some(l => inTests(l) && SKIP_RE.test(l.text))) return 'a skip or xfail marker was added to a test'
  const have = new Set(diffLines(b.diff, '+').map(l => l.text.trim()))
  if (testAdds.some(l => !have.has(l))) return 'the repro test was altered: some of its lines are missing from the diff'
  return ''
}
const joinFailures = fs => fs.map(x => `- [${x.severity}]${x.file ? ` ${x.file}${x.line ? ':' + x.line : ''}` : ''} ${x.problem}${x.needs ? ` Needs: ${x.needs}` : ''}`).join('\n')

let prevDiff = ''
let objections = []
let best = null
let outcome = 'no_valid_draft'
let retriesLeft = MAX_RETRIES
let round = 1
let builds = 0
const fixHistory = []
while (round <= MAX_ROUNDS) {
  const label = `r${round}b${++builds}`
  const b = await spawn(
    `Fix the surviving cause in your own worktree. First apply this failing test exactly as given and confirm it fails; never edit, skip or loosen it or any other test.\n` +
    `Test command: ${reproTest.test_command}\nTest diff:\n${reproTest.test_diff}\nFailure the writer saw:\n${clip(reproTest.red_output, 3000, 'red output')}\n\n${survivorBrief}\n\n` +
    `Decision records: ${records.length ? records.join(', ') : '(none listed; search the repository)'}.\nCritic round ${round} of ${MAX_ROUNDS}.` +
    (prevDiff ? `\n\nPrevious draft (reapply it in your fresh worktree, then address the objections):\n${prevDiff}` : '') +
    (objections.length ? `\n\nObjections:\n${joinFailures(objections)}` : ''),
    { agentType: AGENT('duel-fix-builder'), isolation: 'worktree', label: `build:${label}`, phase: 'Fix', schema: BUILD })
  if (!b) { fixHistory.push({ round, result: 'builder failed' }); outcome = best ? 'open_objections' : 'no_valid_draft'; break }
  if (b.status === 'declined') { fixHistory.push({ round, result: 'declined: ' + b.notes }); outcome = 'declined'; break }
  const gate = gateError(b)
  if (gate) {
    fixHistory.push({ round, result: 'gate: ' + gate })
    // Keep the critic's open objections and add the gate failure; a draft the gate rejected is never handed on as "previous draft".
    objections = objections.filter(o => !o.gate).concat({ severity: 'blocker', problem: 'gate: ' + gate, gate: true })
    if (gate === ISOLATION) { warnings.push(`${ISOLATION}; run git status in ${root}`); outcome = 'isolation_failed'; break }
    if (retriesLeft-- > 0) continue
    log(`fix retries exhausted (${MAX_RETRIES}); last gate failure: ${gate}`)
    outcome = best ? 'open_objections' : 'gate_failed'
    break
  }
  prevDiff = b.diff
  const c = await spawn(
    `Review the fix for ${top.id} (round ${round} of ${MAX_ROUNDS}). You have no shell: read the diff and the worktree files.\n` +
    `${survivorBrief}\n\nWorktree (read files here): ${b.worktree_path || '(unknown)'}\nTest command: ${b.test_command}\n\n` +
    `Failing output before the fix:\n${clip(b.red_output, 3000, 'red ' + label)}\n\nPassing output after:\n${clip(b.green_output, 3000, 'green ' + label)}\n\nDiff:\n${b.diff}\n\n` +
    `Builder notes: ${b.notes || '(none)'}\nBuilder replies to earlier objections: ${b.objection_replies.join(' | ') || '(none)'}\n` +
    `Decision records: ${records.length ? records.join(', ') : '(none listed; search the repository)'}.`,
    { agentType: AGENT('root-cause-critic'), label: `critic:${label}`, phase: 'Fix', schema: CRITIC })
  if (!c) { best = { draft: b, blockers: 99, failures: [] }; outcome = 'unreviewed'; fixHistory.push({ round, result: 'critic failed; the patch is unreviewed' }); break }
  if (c.verdict === 'PASS' && !c.opened.length) { c.verdict = 'FAIL'; c.failures = [{ check: 0, severity: 'blocker', problem: 'the critic returned PASS without opening any file, so the PASS does not count' }] }
  const blockers = c.failures.filter(x => x.severity === 'blocker').length
  fixHistory.push({ round, result: c.verdict, blockers })
  if (!best || blockers <= best.blockers) best = { draft: b, blockers, failures: c.failures }
  if (c.verdict === 'PASS') { outcome = 'pass'; best = { draft: b, blockers: 0, failures: c.failures }; break }
  objections = c.failures
  outcome = 'open_objections'
  round++
}
if (outcome === 'open_objections' && round > MAX_ROUNDS) log(`the critic did not pass in ${MAX_ROUNDS} rounds; returning the best draft with its open objections`)

const d = best ? best.draft : null
return {
  status: outcome === 'pass' ? 'fixed' : 'not_fixed_' + outcome,
  message: outcome === 'pass'
    ? 'The critic passed the fix. It lives only in the builder worktree; read the diff and merge it yourself.'
    : `No clean fix: ${outcome}. ${d ? 'The best draft is returned with its open objections; do not merge it unreviewed.' : 'No valid draft exists.'}`,
  survivor: { id: top.id, claim: top.claim }, other_survivors: others,
  repro: { worktree_path: reproTest.worktree_path, test_command: reproTest.test_command, test_diff: reproTest.test_diff, red_output: reproTest.red_output, history: reproHistory },
  fix: d ? { outcome, rounds: fixHistory.length, history: fixHistory, worktree_path: d.worktree_path, branch: d.branch || '', diff: d.diff, green_output: d.green_output, notes: d.notes, open_objections: outcome === 'pass' ? [] : best.failures } : { outcome, history: fixHistory },
  ...snap(),
}
