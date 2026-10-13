export const meta = {
  name: 'incident-timeline-postmortem',
  description: 'Reconstruct an ended incident from retained evidence: one collector per source, code merge and clock-skew check, blind per-event citation verification, a causal chain built only from verified events, one refuter per causal link, and a read-only blameless critic loop (3 rounds at most). Two planted canaries (a fabricated event and an impossible link) must be caught or no postmortem is produced.',
  phases: [
    { title: 'Collect', detail: 'one collector per evidence source (max 8); code merges, dedupes, sorts, caps and flags clock skew' },
    { title: 'Verify events', detail: 'one blind verifier per event (max 200) plus one planted fabricated event' },
    { title: 'Analyse', detail: 'causal-chain analyst on verified events only, then one refuter per link (max 12) plus one planted impossible link' },
    { title: 'Critique', detail: 'blameless critic, at most 3 rounds, then the best draft with its open objections' },
  ],
}

// args: { sources: [path | {path, kind?, note?}], window: {start, end}, records?: [decision record paths], title?,
//         skewSeconds?, maxSources?, maxEvents?, maxLinks?, maxRounds?, agentPrefix?: "agent-teams:" }
// A JSON string is accepted and parsed. window.start and window.end are ISO 8601 with a timezone offset. Caller values can only lower the caps.
// agentPrefix goes in front of each agent name. The default fits a plugin install; pass "" when the agents are installed bare
// (symlinks into ~/.claude/agents, or --plugin-dir).
// The runtime has no clock, so the wall-clock limit belongs to the caller, for example `timeout 3600 claude -p ...`.
// The result is a draft returned to the caller. Publishing it anywhere is a separate approval.

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) {
    return { error: 'args is a string that is not valid JSON (' + e.message + '); nothing ran' }
  }
}
const USAGE = 'incident-timeline-postmortem needs args {sources: [path or {path, kind?}], window: {start, end} as ISO 8601 with a timezone offset, records?: [decision record paths], title?, skewSeconds?, maxSources?, maxEvents?, maxLinks?, maxRounds?, agentPrefix?}; nothing ran'
if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: USAGE }

const asList = v => (Array.isArray(v) ? v : [])
const sourcesIn = asList(input.sources)
  .map(s => (typeof s === 'string' ? { path: s } : s))
  .filter(s => s && typeof s.path === 'string' && s.path.trim())
  .map((s, i) => ({ id: `S${i + 1}`, path: s.path.trim().replace(/(.)\/+$/, '$1'), kind: typeof s.kind === 'string' ? s.kind : '', note: typeof s.note === 'string' ? s.note : '' }))
const records = asList(input.records).filter(x => typeof x === 'string' && x)

const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i
const parseTs = s => (typeof s === 'string' && OFFSET.test(s.trim()) ? Date.parse(s.trim()) : NaN)
const wStart = parseTs(input.window && input.window.start)
const wEnd = parseTs(input.window && input.window.end)
if (!sourcesIn.length) return { error: 'no evidence source with a path was given; nothing ran. ' + USAGE }
if (Number.isNaN(wStart) || Number.isNaN(wEnd)) return { error: 'window.start and window.end must be ISO 8601 timestamps with a timezone offset (Z or +09:00); nothing ran' }
if (wStart >= wEnd) return { error: 'window.start must be before window.end; nothing ran' }

// Hard ceilings live here, in code. Caller values can only lower them.
const HARD = { sources: 8, events: 200, perSource: 30, links: 12, rounds: 3, agents: 240 }
const cap = (v, hard, min) => (Number.isInteger(v) && v >= min ? Math.min(v, hard) : hard)
const MAX_SOURCES = cap(input.maxSources, HARD.sources, 1)
const MAX_EVENTS = cap(input.maxEvents, HARD.events, 2)
const MAX_LINKS = cap(input.maxLinks, HARD.links, 1)
const MAX_ROUNDS = cap(input.maxRounds, HARD.rounds, 1)
const SKEW_S = Number.isFinite(input.skewSeconds) && input.skewSeconds > 0 ? input.skewSeconds : 120
const PREFIX = input.agentPrefix !== undefined ? input.agentPrefix : 'agent-teams:'
if (typeof PREFIX !== 'string') return { error: 'agentPrefix must be a string ("" for bare agent names); nothing ran' }
const AGENT = name => PREFIX + name
const TITLE = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Incident'
const MIN_BUDGET = 150000
log(`caps: sources ${MAX_SOURCES}, events ${MAX_EVENTS} (${HARD.perSource} per source), links ${MAX_LINKS}, critic rounds ${MAX_ROUNDS}, agents ${HARD.agents}, skew threshold ${SKEW_S}s`)

const notChecked = { sources: [], events: [], links: [] }
const failed_sources = []
const excluded = []
const failed_stages = []
let spawned = 0
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

const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }

const COLLECT = {
  type: 'object',
  properties: {
    source_id: STR,
    unreadable: { type: 'boolean' },
    coverage: STR,
    notes: STR,
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          timestamp: STR,
          tz_basis: { type: 'string', enum: ['explicit', 'assumed'] },
          tz_note: STR,
          actor: STR,
          what: STR,
          importance: { type: 'string', enum: ['high', 'normal'] },
          source: STR,
          locator: STR,
          locator_kind: { type: 'string', enum: ['line', 'commit', 'message', 'record'] },
          quote: STR,
          correlation_key: STR,
          names_found: STRS,
        },
        required: ['timestamp', 'tz_basis', 'actor', 'what', 'importance', 'source', 'locator', 'locator_kind', 'quote'],
      },
    },
  },
  required: ['source_id', 'unreadable', 'coverage', 'events'],
}

const VERIFY = {
  type: 'object',
  properties: {
    id: STR,
    verdict: { type: 'string', enum: ['CONFIRMED', 'WRONG_TIME', 'NOT_IN_SOURCE'] },
    observed_time: STR,
    reason: STR,
  },
  required: ['id', 'verdict', 'reason'],
}

const ANALYSIS = {
  type: 'object',
  properties: {
    impact: { type: 'object', properties: { text: STR, event_ids: STRS }, required: ['text', 'event_ids'] },
    trigger_event_id: STR,
    impact_start_event_id: STR,
    detection_event_id: STR,
    mitigation_event_id: STR,
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, cause_event_ids: STRS, effect_event_ids: STRS, statement: STR, label: { type: 'string', enum: ['OBSERVED', 'INFERRED'] }, basis: STR },
        required: ['id', 'cause_event_ids', 'effect_event_ids', 'statement', 'label', 'basis'],
      },
    },
    what_went_well: { type: 'array', items: { type: 'object', properties: { text: STR, event_ids: STRS }, required: ['text', 'event_ids'] } },
    action_items: {
      type: 'array',
      items: { type: 'object', properties: { text: STR, owner_role: STR, verification: STR, addresses_link_id: STR }, required: ['text', 'owner_role', 'verification'] },
    },
    unknowns: STRS,
  },
  required: ['impact', 'trigger_event_id', 'impact_start_event_id', 'detection_event_id', 'mitigation_event_id', 'links', 'what_went_well', 'action_items', 'unknowns'],
}

const REVISION = {
  type: 'object',
  properties: {
    impact_text: STR,
    link_statements: {
      type: 'array',
      items: { type: 'object', properties: { id: STR, statement: STR, label: { type: 'string', enum: ['OBSERVED', 'INFERRED'] } }, required: ['id', 'statement'] },
    },
    what_went_well: { type: 'array', items: { type: 'object', properties: { text: STR, event_ids: STRS }, required: ['text', 'event_ids'] } },
    action_items: {
      type: 'array',
      items: { type: 'object', properties: { text: STR, owner_role: STR, verification: STR, addresses_link_id: STR }, required: ['text', 'owner_role', 'verification'] },
    },
    unknowns: STRS,
    objection_replies: STRS,
  },
  required: ['impact_text', 'link_statements', 'what_went_well', 'action_items', 'unknowns', 'objection_replies'],
}

const REFUTE = {
  type: 'object',
  properties: {
    id: STR,
    verdict: { type: 'string', enum: ['HOLDS', 'WEAKENED', 'REFUTED'] },
    alternative_causes: { type: 'array', items: { type: 'object', properties: { explanation: STR, event_ids: STRS }, required: ['explanation'] } },
    contradicting_event_ids: STRS,
    reason: STR,
  },
  required: ['id', 'verdict', 'alternative_causes', 'contradicting_event_ids', 'reason'],
}

const CRITIC = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { check: { type: 'integer' }, severity: { type: 'string', enum: ['blocker', 'minor'] }, location: STR, problem: STR, needs: STR },
        required: ['severity', 'problem'],
      },
    },
    notes: STR,
  },
  required: ['verdict', 'failures'],
}

// ---------------------------------------------------------------- Collect
// This is a barrier on purpose: the event cap, the dedupe, the time sort, the id numbering, the clock-skew check
// and the canary placement all need every source's events at once. The merge itself is code, not an agent.
phase('Collect')
const usedSources = sourcesIn.slice(0, MAX_SOURCES)
for (const s of sourcesIn.slice(MAX_SOURCES)) {
  notChecked.sources.push({ source: s.path, why: `over the ${MAX_SOURCES}-source cap` })
  log(`not checked: source ${s.path} (over the ${MAX_SOURCES}-source cap)`)
}

const WINDOW_TXT = `${input.window.start} to ${input.window.end}`
const collected = await parallel(usedSources.map(s => () => spawn(
  `Collect timeline events from ONE evidence source for an incident postmortem. Read-only: change nothing, contact nothing.\n` +
  `Source id: ${s.id}\nSource path: ${s.path}\n${s.kind ? `Source kind: ${s.kind}\n` : ''}${s.note ? `Caller note: ${s.note}\n` : ''}` +
  `Incident window: ${WINDOW_TXT}. Events outside it are not wanted.\n` +
  `Return at most ${HARD.perSource} events, the ones that matter to the incident (deploys, config changes, errors, alerts, state changes, human decisions and actions, mitigations). ` +
  `Mark importance high for the trigger, the first symptom, the first detection and the mitigation. Do not infer causes. ` +
  `Cite every event with the source file path, a locator (line number, commit hash, message id or record key), and a verbatim quote that a reader can grep for. ` +
  `Return source_id "${s.id}".`,
  { agentType: AGENT('timeline-evidence-collector'), label: `collect:${s.id}`, phase: 'Collect', schema: COLLECT })))

const IMP = { high: 0, normal: 1 }
const underPath = (p, root) => typeof p === 'string' && (p === root || p.startsWith(root + '/'))
function rejectEvent(e, s) {
  for (const k of ['timestamp', 'actor', 'what', 'source', 'locator', 'quote']) {
    if (typeof e[k] !== 'string' || !e[k].trim()) return `missing ${k}`
  }
  if (Number.isNaN(parseTs(e.timestamp))) return 'timestamp without a timezone offset, or unparseable'
  const ms = parseTs(e.timestamp)
  if (ms < wStart || ms > wEnd) return 'outside the incident window'
  if (!underPath(e.source, s.path)) return 'citation points outside the source it was assigned'
  return ''
}

const raw = []
usedSources.forEach((s, i) => {
  const out = collected[i]
  if (!out) { failed_sources.push({ source: s.path, why: 'collector failed or was skipped' }); return }
  if (out.unreadable) { failed_sources.push({ source: s.path, why: out.notes || out.coverage || 'unreadable' }); return }
  const ranked = [...out.events].sort((a, b) => (IMP[a.importance] ?? 1) - (IMP[b.importance] ?? 1))
  ranked.forEach((e, j) => {
    if (j >= HARD.perSource) { notChecked.events.push({ where: `${e.source}:${e.locator}`, what: e.what, why: `over the ${HARD.perSource}-per-source cap` }); return }
    const why = rejectEvent(e, s)
    if (why) { excluded.push({ where: `${e.source || s.path}:${e.locator || '?'}`, what: e.what || '', why }); return }
    raw.push({ ...e, ms: parseTs(e.timestamp), source_id: s.id, srcIndex: i, order: j })
  })
})
for (const f of failed_sources) log(`failed source: ${f.source} (${f.why})`)
if (failed_sources.length === usedSources.length) return { error: 'no source could be read; there is nothing to build a timeline from', failed_sources, notChecked, failed_stages }

// Names that collectors found are removed from everything the document shows. The verbatim quote stays untouched for verification.
const names = [...new Set(raw.flatMap(e => asList(e.names_found)).map(n => String(n).trim()).filter(n => n.length >= 2))].sort((a, b) => b.length - a.length)
// ASCII names match whole words only (so "Al" never rewrites "Alert"); names with other scripts (Hangul takes particles) match as substrings.
const esc = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const nameRes = names.map(n => ({ n, rx: /^[\x20-\x7e]+$/.test(n) ? new RegExp(`(?<![\\p{L}\\p{N}_])${esc(n)}(?![\\p{L}\\p{N}_])`, n.length >= 3 ? 'iu' : 'u') : new RegExp(esc(n), 'u') }))
const findName = t => { const x = nameRes.find(r => r.rx.test(String(t == null ? '' : t))); return x ? x.n : '' }
const redact = s => nameRes.reduce((t, r) => t.replace(new RegExp(r.rx.source, r.rx.flags + 'g'), '[person]'), String(s == null ? '' : s))

const seenKey = new Set()
const deduped = []
for (const e of raw) {
  const k1 = `${e.source}\u0000${e.locator}`
  const k2 = `${e.ms}\u0000${e.what.toLowerCase().replace(/\s+/g, ' ')}`
  if (seenKey.has(k1) || seenKey.has(k2)) { excluded.push({ where: `${e.source}:${e.locator}`, what: e.what, why: 'duplicate' }); continue }
  seenKey.add(k1); seenKey.add(k2)
  deduped.push(e)
}

let keptSet = deduped
if (deduped.length > MAX_EVENTS) {
  // Importance first, then interleave sources so no single noisy source crowds out the rest.
  const ranked = [...deduped].sort((a, b) => (IMP[a.importance] ?? 1) - (IMP[b.importance] ?? 1) || a.order - b.order || a.srcIndex - b.srcIndex)
  keptSet = ranked.slice(0, MAX_EVENTS)
  for (const e of ranked.slice(MAX_EVENTS)) notChecked.events.push({ where: `${e.source}:${e.locator}`, what: e.what, why: `over the ${MAX_EVENTS}-event cap` })
  log(`event cap ${MAX_EVENTS}: ${ranked.length - MAX_EVENTS} event(s) not checked`)
}
const events = keptSet.sort((a, b) => a.ms - b.ms || a.srcIndex - b.srcIndex || a.order - b.order)
events.forEach((e, i) => { e.id = `E${i + 1}`; e.actor = redact(e.actor); e.what = redact(e.what) })
log(`collected ${raw.length} events from ${usedSources.length - failed_sources.length} source(s); merged ${events.length}; excluded ${excluded.length}; not checked ${notChecked.events.length}`)
if (events.length < 2) return { error: 'fewer than 2 usable events after the merge; a postmortem would be fiction', failed_sources, excluded, notChecked, failed_stages }

// Clock skew: the same occurrence recorded by two sources (same correlation_key) at times further apart than the threshold.
const groups = new Map()
for (const e of events) {
  const k = (e.correlation_key || '').trim().toLowerCase()
  if (!k) continue
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(e)
}
const clock_skew = []
for (const [k, g] of groups) {
  if (new Set(g.map(e => e.source_id)).size < 2) continue
  // Compare the first mention per source. Later events of one occurrence (fired, then resolved) are not skew.
  const firsts = []
  for (const e of g) if (!firsts.some(f => f.source_id === e.source_id)) firsts.push(e) // g is time-sorted
  const ms = firsts.map(e => e.ms)
  const delta = (Math.max(...ms) - Math.min(...ms)) / 1000
  if (delta > SKEW_S) {
    clock_skew.push({ key: k, delta_seconds: delta, events: firsts.map(e => ({ id: e.id, source_id: e.source_id, timestamp: e.timestamp })) })
    firsts.forEach(e => { e.skew = true })
  }
}
if (clock_skew.length) log(`clock skew flagged on ${clock_skew.length} correlated occurrence(s)`)

// ---------------------------------------------------------------- Verify events
phase('Verify events')
if (budget.total && budget.remaining() < MIN_BUDGET) {
  return { error: `budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left, below ${MIN_BUDGET / 1000}k; verification skipped and no postmortem produced`, events_collected: events.length, failed_sources, notChecked }
}

// Canary 1: a fabricated event on a real file and a real line whose text is not on that line.
const lineBase = events.filter(e => e.locator_kind === 'line' && /^\d+$/.test(e.locator.trim()))
const base = lineBase.length ? lineBase[Math.floor(lineBase.length / 2)] : events[0]
const weakCanary = !lineBase.length
if (weakCanary) log('canary event is weak: no event cites a numeric line, so it points at line 1 of the first event source')
const canaryEv = {
  id: `E${events.length + 1}`, timestamp: base.timestamp, actor: base.actor, source: base.source,
  locator: lineBase.length ? base.locator : '1', locator_kind: 'line',
  tz_basis: base.tz_basis, tz_note: base.tz_note,
  what: 'Failover to replica shard 4471-q completed', quote: 'failover to replica shard 4471-q completed in 212 ms',
}
const insertAt = Math.floor(events.length / 2)
const stages = [...events.slice(0, insertAt), canaryEv, ...events.slice(insertAt)]

const verifyPrompt = e =>
  `Check one claimed event against its cited source. Event id: ${e.id}\n` +
  `timestamp: ${e.timestamp}\nactor: ${e.actor}\nwhat happened: ${e.what}\n` +
  `timezone basis: ${e.tz_basis === 'assumed' ? `ASSUMED by the collector. The source stamp itself carries no timezone. ${e.tz_note ? 'Collector note: ' + e.tz_note + '. ' : ''}Compare date and wall-clock digits only.` : 'explicit in the source'}\n` +
  `citation: file ${e.source}, ${e.locator_kind} ${e.locator}\nverbatim quote: ${e.quote}\n\n` +
  `Reopen the cited file at that locator and answer CONFIRMED, WRONG_TIME or NOT_IN_SOURCE. Return id "${e.id}".`
const verifyOne = e => spawn(verifyPrompt(e), { agentType: AGENT('timeline-event-verifier'), label: `verify:${e.id}`, phase: 'Verify events', schema: VERIFY })

const verdicts = await pipeline(stages, e => verifyOne(e))
let canaryV = verdicts[insertAt]
if (!canaryV) { log('canary verifier returned nothing; retrying once'); canaryV = await verifyOne(canaryEv) }
if (!canaryV) return { error: 'canary_uncalibrated: the verifier did not answer for the planted fabricated event, so no verdict can be trusted; no postmortem produced', which: 'event', failed_stages }
if (canaryV.verdict !== 'NOT_IN_SOURCE') {
  // WRONG_TIME means the verifier found the fabricated quote at the locator, so it half-confirmed it: a failed calibration too.
  const msg = `canary_failed: the verifier answered ${canaryV.verdict} instead of NOT_IN_SOURCE for the planted fabricated event (${canaryV.reason}); every event verdict in this run is worthless; no postmortem produced`
  log(msg)
  return { error: msg, which: 'event', canary_event_verdict: canaryV.verdict, failed_stages }
}

const verified = []
const rejected_events = []
const unverified_events = []
stages.forEach((e, i) => {
  if (i === insertAt) return
  const v = verdicts[i]
  if (!v) { unverified_events.push({ id: e.id, where: `${e.source}:${e.locator}`, what: e.what, why: 'verifier failed or was skipped' }); return }
  if (v.verdict === 'CONFIRMED') { verified.push(e); return }
  rejected_events.push({ id: e.id, where: `${e.source}:${e.locator}`, what: e.what, verdict: v.verdict, observed_time: v.observed_time || '', reason: v.reason })
})
const collectors_over_claimed = events.length >= 4 && rejected_events.length * 2 > events.length
log(`verified ${verified.length}/${events.length}; rejected ${rejected_events.length}; unverified ${unverified_events.length}; canary event caught`)
if (collectors_over_claimed) log('more than half of the collected events failed verification: the collectors over-claimed; check the sources before trusting this timeline')
if (verified.length < 2) return { error: 'fewer than 2 verified events; there is no timeline to analyse', rejected_events, unverified_events, failed_sources, notChecked, failed_stages }

const byId = new Map(verified.map(e => [e.id, e]))
// The canary link should be refutable on order alone, so prefer events the skew check did not flag.
const clean = verified.filter(e => !e.skew)
const pool = clean.length >= 2 && (clean[clean.length - 1].ms - clean[0].ms) / 1000 > SKEW_S ? clean : verified
const first = pool[0]
const last = pool[pool.length - 1]
if ((last.ms - first.ms) / 1000 <= SKEW_S) {
  return { error: `canary_link_impossible: the verified timeline spans only ${(last.ms - first.ms) / 1000}s, not more than the skew threshold of ${SKEW_S}s, so an impossible-order canary link cannot be planted; pass a smaller skewSeconds if that span is real`, verified_events: verified.length }
}

// ---------------------------------------------------------------- Analyse
phase('Analyse')
const fmtEv = e => `${e.id} ${e.timestamp} [${e.source_id}] ${e.actor}: ${e.what} {${e.source}:${e.locator}}${e.skew ? ' (clock skew flagged)' : ''}`
const timelineTxt = verified.map(fmtEv).join('\n')
const recTxt = records.length ? records.join(', ') : '(none listed: search the repository for incident, ADR, runbook and postmortem files and say which you found)'

// Barrier: the analyst reads the whole verified timeline, so every verdict must be in.
const raw1 = await spawn(
  `Build the causal chain for the incident "${TITLE}" from the VERIFIED timeline below. Window: ${WINDOW_TXT}.\n` +
  `Decision records you MUST read first: ${recTxt}.\n\nVerified timeline (the only facts you may use):\n${timelineTxt}\n\n` +
  `Cite events by id. Label each link OBSERVED only when a verified event itself records the relationship; otherwise INFERRED. ` +
  `At most ${MAX_LINKS} links. Use an empty string where no verified event shows a start, detection or mitigation.`,
  { agentType: AGENT('causal-chain-analyst'), label: 'analyse', phase: 'Analyse', schema: ANALYSIS })
if (!raw1) return { error: 'the causal-chain analyst failed; no postmortem produced', verified_events: verified.length, rejected_events, failed_stages }

const okIds = ids => asList(ids).filter(x => byId.has(x))
const oneId = id => (byId.has(id) ? id : '')
const idMap = new Map()
const proposed = asList(raw1.links).map(l => ({ ...l, cause: okIds(l.cause_event_ids), effect: okIds(l.effect_event_ids) }))
const usable = l => l.cause.length && l.effect.length && typeof l.statement === 'string' && l.statement.trim()
const cleaned = proposed.filter(usable)
for (const l of cleaned.slice(MAX_LINKS)) {
  notChecked.links.push({ statement: l.statement, why: `over the ${MAX_LINKS}-link cap` })
  log(`not checked: link "${l.statement}" (over the ${MAX_LINKS}-link cap)`)
}
const dropped_links = proposed.filter(l => !usable(l)).map(l => ({ statement: String(l.statement || ''), why: 'cited no verified event' }))
if (dropped_links.length) log(`${dropped_links.length} link(s) dropped for citing no verified event`)
const links = cleaned.slice(0, MAX_LINKS).map((l, i) => {
  idMap.set(l.id, `L${i + 1}`)
  return { id: `L${i + 1}`, cause: l.cause, effect: l.effect, statement: l.statement.trim(), label: l.label, basis: l.basis || '' }
})

const toRefute = []
const autoRefuted = []
for (const l of links) {
  // Even the earliest cause must postdate the earliest effect for the order to be plainly impossible (one late cause among several is fine).
  // A link touching a skew-flagged event goes to the refuter, whose rule exempts flagged skew.
  const earliestCause = Math.min(...l.cause.map(id => byId.get(id).ms))
  const earliestEffect = Math.min(...l.effect.map(id => byId.get(id).ms))
  const touchesSkew = [...l.cause, ...l.effect].some(id => byId.get(id).skew)
  if (!touchesSkew && (earliestCause - earliestEffect) / 1000 > SKEW_S) {
    autoRefuted.push({ ...l, refutation: { verdict: 'REFUTED', by: 'code', alternative_causes: [], contradicting_event_ids: [...l.cause, ...l.effect], reason: `code check: even the earliest cause postdates the earliest effect by ${Math.round((earliestCause - earliestEffect) / 1000)}s, more than the ${SKEW_S}s skew threshold` } })
  } else toRefute.push(l)
}

// Canary 2: the cause is the last verified event and the effect is the first, so the stated cause postdates its effect.
const canaryLink = {
  id: `L${links.length + 1}`, cause: [last.id], effect: [first.id],
  statement: `${last.what} (${last.id}) caused ${first.what} (${first.id}).`, label: 'OBSERVED', basis: '',
}
const linkStages = [...toRefute.slice(0, Math.floor(toRefute.length / 2)), canaryLink, ...toRefute.slice(Math.floor(toRefute.length / 2))]
const canaryAt = Math.floor(toRefute.length / 2)

const evLine = id => `${id} ${byId.get(id).timestamp} ${byId.get(id).what}`
const refutePrompt = l =>
  `Attack one causal link from an incident postmortem. Link id: ${l.id}\nclaim: ${l.statement}\n` +
  `cause events:\n${l.cause.map(evLine).join('\n')}\neffect events:\n${l.effect.map(evLine).join('\n')}\n\n` +
  `Verified timeline:\n${timelineTxt}\n\nDecision records you MUST read: ${recTxt}.\n` +
  `Ask: what else explains this effect, and what in the timeline contradicts this link? Return id "${l.id}".`
const refuteOne = l => spawn(refutePrompt(l), { agentType: AGENT('alternative-cause-refuter'), label: `refute:${l.id}`, phase: 'Analyse', schema: REFUTE })

if (budget.total && budget.remaining() < MIN_BUDGET) log(`budget guard: ${Math.round(budget.remaining() / 1000)}k tokens left; refutation may be cut short by the hard ceiling`)
const refVerdicts = await pipeline(linkStages, l => refuteOne(l))
let canaryL = refVerdicts[canaryAt]
if (!canaryL) { log('canary refuter returned nothing; retrying once'); canaryL = await refuteOne(canaryLink) }
if (!canaryL) return { error: 'canary_uncalibrated: the refuter did not answer for the planted impossible link, so no refutation can be trusted; no postmortem produced', which: 'link', failed_stages }
if (canaryL.verdict !== 'REFUTED') {
  const msg = `canary_failed: the refuter said ${canaryL.verdict} for a link whose stated cause postdates its effect (${canaryL.reason}); its verdicts cannot be trusted; no postmortem produced`
  log(msg)
  return { error: msg, which: 'link', canary_link_verdict: canaryL.verdict, failed_stages }
}

const chain = []
const refuted_links = [...autoRefuted]
toRefute.forEach(l => {
  const i = linkStages.indexOf(l)
  const v = refVerdicts[i]
  const refutation = v ? { ...v, by: 'agent' } : { verdict: 'NOT_CHECKED', by: 'none', alternative_causes: [], contradicting_event_ids: [], reason: 'refuter failed or was skipped' }
  if (refutation.verdict === 'REFUTED') refuted_links.push({ ...l, refutation })
  else chain.push({ ...l, label: refutation.verdict === 'WEAKENED' ? 'INFERRED' : l.label, refutation })
})
chain.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
log(`links: ${links.length}; chain ${chain.length}; refuted ${refuted_links.length} (${autoRefuted.length} by the time-order code check); canary link caught`)

const finalId = old => { const n = idMap.get(old); return n && chain.some(l => l.id === n) ? n : '' }
const cleanWell = arr => asList(arr).filter(x => x && typeof x.text === 'string' && x.text.trim()).map(x => ({ text: x.text.trim(), event_ids: okIds(x.event_ids) }))
const cleanActions = (arr, mapId) => asList(arr).filter(x => x && typeof x.text === 'string' && x.text.trim())
  .map(x => ({ text: x.text.trim(), owner_role: String(x.owner_role || '').trim(), verification: String(x.verification || '').trim(), addresses_link_id: mapId(x.addresses_link_id || '') }))

let model = {
  impact: { text: String(raw1.impact.text || '').trim(), event_ids: okIds(raw1.impact.event_ids) },
  trigger: oneId(raw1.trigger_event_id), start: oneId(raw1.impact_start_event_id), detect: oneId(raw1.detection_event_id), mitigate: oneId(raw1.mitigation_event_id),
  well: cleanWell(raw1.what_went_well),
  actions: cleanActions(raw1.action_items, finalId),
  unknowns: asList(raw1.unknowns).filter(x => typeof x === 'string' && x.trim()),
}

// ---------------------------------------------------------------- Draft rendering (code, so every timeline line carries its citation)
const dur = (a, b) => {
  if (!a || !b) return null
  const s = (byId.get(b).ms - byId.get(a).ms) / 1000
  return s < 0 ? null : s
}
const fmtDur = s => {
  if (s === null) return 'unknown'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.round(s % 60)
  return [h ? `${h}h` : '', m ? `${m}m` : '', r || (!h && !m) ? `${r}s` : ''].filter(Boolean).join(' ')
}
const ref = ids => (ids.length ? ` (${ids.join(', ')})` : ' (no verified event cited)')
const oneLine = s => redact(s).replace(/\s+/g, ' ').trim()

function render(m) {
  const L = []
  L.push(`# Postmortem draft: ${oneLine(TITLE)}`, '')
  L.push(`Status: DRAFT for human review. Built from ${verified.length} verified events in the window ${WINDOW_TXT}. Anything the evidence does not show is marked unknown, not filled in.`, '')
  L.push('## Impact', '', oneLine(m.impact.text || 'unknown') + ref(m.impact.event_ids), '')
  L.push('## Timeline', '')
  for (const e of verified) {
    const flags = (e.skew ? ' [clock skew flagged]' : '') + (e.tz_basis === 'assumed' ? ` [timezone assumed${e.tz_note ? ': ' + oneLine(e.tz_note) : ''}]` : '')
    L.push(`- ${e.timestamp} [${e.id}] ${oneLine(e.actor)}: ${oneLine(e.what)} (${e.source}:${e.locator}, "${oneLine(e.quote)}")${flags}`)
  }
  L.push('', '## Detection and mitigation', '')
  L.push(`- Time from impact start to detection: ${fmtDur(dur(m.start, m.detect))}${m.start && m.detect ? ` (${m.start} to ${m.detect})` : ''}`)
  L.push(`- Time from detection to mitigation: ${fmtDur(dur(m.detect, m.mitigate))}${m.detect && m.mitigate ? ` (${m.detect} to ${m.mitigate})` : ''}`)
  L.push(`- Time from impact start to mitigation: ${fmtDur(dur(m.start, m.mitigate))}`, '')
  L.push('## Causal chain', '')
  if (m.trigger) L.push(`Trigger event: ${m.trigger}.`, '')
  if (!chain.length) L.push('No causal link survived refutation or was supported. The cause is unknown.', '')
  for (const l of chain) {
    const lead = l.label === 'OBSERVED' ? 'Observed' : 'Inferred, not observed'
    L.push(`- ${l.id} ${lead} (${l.cause.join(', ')} to ${l.effect.join(', ')}): ${oneLine(l.statement)}`)
    if (l.refutation.verdict === 'WEAKENED') L.push(`  - Weakened by the refuter: ${oneLine(l.refutation.reason)}`)
    if (l.refutation.verdict === 'NOT_CHECKED') L.push('  - Not independently checked: the refuter did not return.')
    for (const a of l.refutation.alternative_causes || []) L.push(`  - Alternative not ruled out: ${oneLine(a.explanation)}${a.event_ids && a.event_ids.length ? ` (${a.event_ids.join(', ')})` : ''}`)
  }
  if (chain.length) L.push('')
  if (refuted_links.length) {
    L.push('## Causal links considered and refuted', '')
    for (const l of refuted_links) L.push(`- ${l.id} (${l.cause.join(', ')} to ${l.effect.join(', ')}): ${oneLine(l.statement)}. Refuted${l.refutation.by === 'code' ? ' by a code check' : ''}: ${oneLine(l.refutation.reason)}`)
    L.push('')
  }
  L.push('## What went well', '')
  if (!m.well.length) L.push('- None identified from the verified events.')
  for (const w of m.well) L.push(`- ${oneLine(w.text)}${ref(w.event_ids)}`)
  L.push('', '## Action items', '', '| Action | Owner role | How to verify it is done | Addresses |', '|---|---|---|---|')
  if (!m.actions.length) L.push('| none proposed | | | |')
  for (const a of m.actions) L.push(`| ${oneLine(a.text)} | ${oneLine(a.owner_role) || 'MISSING'} | ${oneLine(a.verification) || 'MISSING'} | ${a.addresses_link_id || '-'} |`)
  L.push('', '## Unknowns and evidence not used', '')
  const unk = [...m.unknowns.map(oneLine)]
  if (!m.start) unk.push('The start of customer impact is not shown by any verified event.')
  if (!m.detect) unk.push('The moment of detection is not shown by any verified event.')
  if (!m.mitigate) unk.push('The moment of mitigation is not shown by any verified event.')
  for (const f of failed_sources) unk.push(`Source not read: ${f.source} (${oneLine(f.why)}).`)
  if (dropped_links.length) unk.push(`Proposed causal link(s) dropped for citing no verified event: ${dropped_links.length}.`)
  for (const s of notChecked.sources) unk.push(`Source not checked: ${s.source} (${s.why}).`)
  if (notChecked.events.length) unk.push(`${notChecked.events.length} collected event(s) were not verified because of caps.`)
  if (excluded.length) unk.push(`${excluded.length} collected event(s) were excluded by code checks (missing fields, no timezone, outside the window, duplicate).`)
  if (rejected_events.length) unk.push(`${rejected_events.length} event(s) failed citation verification and are not in the timeline: ${rejected_events.map(r => `${r.id} ${r.verdict}`).join(', ')}.`)
  if (unverified_events.length) unk.push(`${unverified_events.length} event(s) could not be verified because the verifier failed.`)
  for (const c of clock_skew) unk.push(`Clock skew: the same occurrence "${oneLine(c.key)}" is stamped ${Math.round(c.delta_seconds)}s apart across sources (${c.events.map(e => e.id).join(', ')}); ordering across these sources is uncertain.`)
  if (notChecked.links.length) unk.push(`${notChecked.links.length} proposed causal link(s) were not checked because of the link cap.`)
  if (!unk.length) L.push('- None recorded.')
  for (const u of unk) L.push(`- ${u}`)
  return L.join('\n') + '\n'
}

const BLAME = /\b(blame[ds]?|negligen\w*|careless\w*|incompetent|sloppy|lazy|fault of|should have (?:known|caught|noticed|tested)|human error)\b/i
function lint(m) {
  const f = []
  const add = (check, location, problem, needs) => f.push({ check, severity: 'blocker', location, problem, needs })
  if (!m.well.length) add(5, 'What went well', 'the section is empty', 'name what worked, citing events, or state that the verified events show nothing that went well')
  if (!m.impact.event_ids.length) add(2, 'Impact', 'the impact statement cites no verified event', 'cite the events that show the impact or write unknown')
  for (const w of m.well) if (!w.event_ids.length) add(2, 'What went well', `"${w.text}" cites no verified event`, 'cite an event or remove the item')
  m.actions.forEach((a, i) => {
    if (!a.owner_role) add(4, `Action item ${i + 1}`, 'no owner role', 'name a role, never a person')
    if (!a.verification) add(4, `Action item ${i + 1}`, 'no way to verify completion', 'say what observable result shows it is done')
    if (findName(a.owner_role)) add(1, `Action item ${i + 1}`, 'owner is a person, not a role', 'use a role')
  })
  const texts = [m.impact.text, ...m.well.map(w => w.text), ...m.actions.map(a => a.text), ...m.unknowns, ...chain.map(l => l.statement)]
  for (const t of texts) {
    if (BLAME.test(t || '')) add(1, 'free text', `blame language: "${(t || '').slice(0, 80)}"`, 'rewrite as a system or process fact')
    if (findName(t)) add(1, 'free text', 'a person is named in analyst text', 'use a role or the system name')
  }
  return f
}

// ---------------------------------------------------------------- Critique
phase('Critique')
const CHECKS =
  `1. Names or blame language about people anywhere in the document.\n` +
  `2. Any timeline line, impact statement or what-went-well item without a citation to a verified event.\n` +
  `3. A cause stated as fact when the link is labelled inferred, or a claim with no evidence behind it.\n` +
  `4. Action items without an owner ROLE or without a way to verify completion.\n` +
  `5. A missing or empty "What went well" section.`
const linkSummary = () => [...chain.map(l => `${l.id} ${l.label} ${l.refutation.verdict}`), ...refuted_links.map(l => `${l.id} REFUTED (not editable)`)].join('; ')

let best = null
const rounds = []
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const doc = render(model)
  const codeLint = lint(model)
  const c = await spawn(
    `Review this postmortem draft against the written standard. Round ${round} of ${MAX_ROUNDS}.\n` +
    `Decision records you MUST read first: ${recTxt}.\n\nChecks:\n${CHECKS}\n\nDraft:\n\n${doc}`,
    { agentType: AGENT('blameless-critic'), label: `critic:r${round}`, phase: 'Critique', schema: CRITIC })
  if (!c) {
    rounds.push({ round, result: 'critic failed' })
    if (!best) best = { doc, failures: codeLint, score: 1e6, round, reviewed: false, pass: false }
    break
  }
  const criticFailures = c.verdict === 'FAIL' ? asList(c.failures) : []
  // A FAIL that lists nothing is still a FAIL: it must never degrade to PASS.
  if (c.verdict !== 'PASS' && !criticFailures.length) criticFailures.push({ severity: 'blocker', location: 'critic', problem: 'the critic returned FAIL without listing any failure', needs: 'treat the draft as unreviewed in the points the critic meant; a human must read it' })
  const failures = [...criticFailures, ...codeLint]
  const pass = c.verdict === 'PASS' && codeLint.length === 0
  const score = failures.filter(x => x.severity === 'blocker').length * 100 + failures.length
  if (!best || score <= best.score) best = { doc, failures: pass ? [] : failures, score, round, reviewed: true, pass }
  rounds.push({ round, verdict: pass ? 'PASS' : 'FAIL', failures: failures.length, lint: codeLint.length })
  log(`critic round ${round}: ${pass ? 'PASS' : `FAIL (${failures.length} failure(s), ${codeLint.length} from code lint)`}`)
  if (pass || round === MAX_ROUNDS) break

  const rev = await spawn(
    `Revise the postmortem model to answer the critic. Revision for round ${round + 1} of ${MAX_ROUNDS}.\n` +
    `Decision records you MUST read first: ${recTxt}.\n\nVerified timeline (the only facts you may use):\n${timelineTxt}\n\n` +
    `Current model:\n${JSON.stringify({ impact: model.impact, what_went_well: model.well, action_items: model.actions, unknowns: model.unknowns, links: chain.map(l => ({ id: l.id, label: l.label, statement: l.statement })) })}\n` +
    `Link states: ${linkSummary()}\n\nObjections to answer:\n${failures.map(x => `- [${x.severity}] ${x.location || ''} ${x.problem}${x.needs ? ' Needs: ' + x.needs : ''}`).join('\n')}\n\n` +
    `Rules: you may reword statements, labels (to INFERRED only), impact text, what went well, action items and unknowns. You may not add, remove or re-aim a causal link, and you may not use a fact outside the verified timeline.`,
    { agentType: AGENT('causal-chain-analyst'), label: `revise:r${round + 1}`, phase: 'Critique', schema: REVISION })
  if (!rev) { rounds.push({ round: round + 1, result: 'revision failed' }); break }

  const stmt = new Map(asList(rev.link_statements).filter(x => x && x.id && typeof x.statement === 'string' && x.statement.trim()).map(x => [x.id, x]))
  for (const l of chain) {
    const s = stmt.get(l.id)
    if (!s) continue
    l.statement = s.statement.trim()
    if (s.label === 'INFERRED') l.label = 'INFERRED'
  }
  const sameId = id => (chain.some(l => l.id === id) ? id : '')
  const well = cleanWell(rev.what_went_well)
  const actions = cleanActions(rev.action_items, sameId)
  model = {
    ...model,
    impact: { text: String(rev.impact_text || '').trim() || model.impact.text, event_ids: model.impact.event_ids },
    well: well.length ? well : model.well,
    actions: actions.length ? actions : model.actions,
    unknowns: asList(rev.unknowns).length ? asList(rev.unknowns).filter(x => typeof x === 'string' && x.trim()) : model.unknowns,
  }
}

const open_objections = best ? best.failures : []
const status = !best ? 'NO_DRAFT' : !best.reviewed ? 'UNREVIEWED' : best.pass ? 'PASS' : 'OPEN_OBJECTIONS'
if (status === 'OPEN_OBJECTIONS') log(`stopped after ${rounds.filter(r => r.verdict).length} critic round(s) with ${open_objections.length} open objection(s); returning the best draft (round ${best.round})`)
if (notChecked.events.length || notChecked.sources.length || notChecked.links.length) {
  log(`notChecked: ${notChecked.sources.length} source(s), ${notChecked.events.length} event(s), ${notChecked.links.length} link(s)`)
}

return {
  status,
  postmortem: best ? best.doc : '',
  open_objections,
  rounds,
  timeline: verified.map(e => ({ id: e.id, timestamp: e.timestamp, source: e.source, locator: e.locator, quote: e.quote, skew: !!e.skew })),
  links: chain.map(l => ({ id: l.id, label: l.label, cause: l.cause, effect: l.effect, statement: l.statement, verdict: l.refutation.verdict })),
  refuted_links: refuted_links.map(l => ({ id: l.id, statement: l.statement, by: l.refutation.by, reason: l.refutation.reason })),
  rejected_events, unverified_events, excluded, dropped_links, clock_skew, failed_sources, notChecked, failed_stages,
  collectors_over_claimed,
  canary: { event: canaryV.verdict, event_strength: weakCanary ? 'weak' : 'line', link: canaryL.verdict },
  caps: { sources: MAX_SOURCES, events: MAX_EVENTS, links: MAX_LINKS, rounds: MAX_ROUNDS, agents: HARD.agents, agents_spawned: spawned, wall_clock: 'enforced by the caller with timeout; the runtime has no clock' },
}
