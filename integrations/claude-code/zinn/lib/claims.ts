// Who holds a task, from the `claim` object the CLI prints on every task (Zinn 0.45.0 and later). Pure.
//
// "Mine" is a claim whose session id is this Claude Code session's id: the value zinn-identity declares as
// ZINN_SESSION_ID, which a claim records as `actor_session_id`. The actor name cannot tell sessions apart:
// every Claude Code agent of one version claims under the same name.
//
// A claim runs out without any write to the store, so a claim read as live may have expired since. Every
// drawing judges `expires_at` against the clock.
import type { Span, ThemeColor } from './style'

export type Claim = {
  state: 'live' | 'expired'
  actorKind: string
  actorName: string
  sessionId: string | null
  claimedAt: number | null
  expiresAt: number | null
}

/** What a drawing needs to say who holds a task: this session's id (null when unknown) and the time to judge expiry by. */
export type ClaimCtx = { me: string | null; now: number }

/** Mine, another holder's, or a claim that ran out. */
export type Holder = 'mine' | 'theirs' | 'expired'

/** The board's mark after a held task's key. A character apart, so they differ with colour off too. */
export const HOLDER_MARK: Readonly<Record<'mine' | 'theirs', string>> = { mine: '◆', theirs: '◇' }
/** Another holder's claim is painted in this theme key. Mine stays dim. */
export const THEIRS_COLOR: ThemeColor = 'warning'

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The `claim` field of one task as the CLI prints it. Null for no claim or a shape the mod does not know. */
export function claimOf(v: unknown): Claim | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  const c = v as Record<string, unknown>
  if (c['state'] !== 'live' && c['state'] !== 'expired') {
    return null
  }
  return {
    state: c['state'],
    actorKind: text(c['actor_kind']),
    actorName: text(c['actor_name']),
    sessionId: typeof c['actor_session_id'] === 'string' ? c['actor_session_id'] : null,
    claimedAt: ms(c['claimed_at']),
    expiresAt: ms(c['expires_at']),
  }
}

/** Who holds the task at `now`. Null when nobody claimed it. `me` is this session's id, null when unknown. */
export function holderOf(c: Claim | null, me: string | null, now: number): Holder | null {
  if (c === null) {
    return null
  }
  const ranOut = c.state === 'expired' || (c.expiresAt !== null && c.expiresAt <= now)
  if (ranOut) {
    return 'expired'
  }
  return me !== null && c.sessionId === me ? 'mine' : 'theirs'
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local wall time: `14:30` on the day of `now`, `2026-11-19 14:30` on any other day. */
export function wallTime(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? hm : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}

/** What a claimed task's legend entry ends with: ` · yours until 14:30` (dim) or ` · held until 14:30`. Nothing for an expired claim. */
export function legendClaim(c: Claim | null, me: string | null, now: number): Span[] {
  const h = holderOf(c, me, now)
  if (h === null || h === 'expired') {
    return []
  }
  const until = c!.expiresAt === null ? '' : ` until ${wallTime(c!.expiresAt, now)}`
  return h === 'mine'
    ? [{ s: ` · yours${until}`, style: { dimColor: true } }]
    : [{ s: ` · held${until}`, style: { color: THEIRS_COLOR } }]
}

/** The board's mark cell for one task: the holder's mark, or a space. Expired claims draw nothing. */
export function boardMark(c: Claim | null, me: string | null, now: number): Span {
  const h = holderOf(c, me, now)
  if (h === 'mine') {
    return { s: HOLDER_MARK.mine, style: {} }
  }
  if (h === 'theirs') {
    return { s: HOLDER_MARK.theirs, style: { color: THEIRS_COLOR } }
  }
  return { s: ' ', style: {} }
}

/**
 * The pane's claim line: `◆ this session · claude-code_2-1-327_agent (agent) · since 20:24 · until 22:24`.
 * An expired claim says `expired` and when. Null when the task has no claim.
 */
export function claimLine(c: Claim | null, me: string | null, now: number): Span[] | null {
  const h = holderOf(c, me, now)
  if (h === null) {
    return null
  }
  const dim = (s: string): Span => ({ s, style: { dimColor: true } })
  const out: Span[] =
    h === 'mine' ? [{ s: `${HOLDER_MARK.mine} this session`, style: {} }]
      : h === 'theirs' ? [{ s: `${HOLDER_MARK.theirs} another session`, style: { color: THEIRS_COLOR } }]
        : [dim('expired claim')]
  const who = [c!.actorName, c!.actorKind === '' ? '' : `(${c!.actorKind})`].filter(Boolean).join(' ')
  if (who !== '') {
    out.push(dim(` · ${who}`))
  }
  if (c!.claimedAt !== null) {
    out.push(dim(` · since ${wallTime(c!.claimedAt, now)}`))
  }
  if (c!.expiresAt !== null) {
    out.push(dim(` · ${h === 'expired' ? 'expired' : 'until'} ${wallTime(c!.expiresAt, now)}`))
  }
  return out
}

/** Keys this session holds at `now`, the latest claim first. Empty when `me` is unknown. */
export function heldKeys(tasks: ReadonlyMap<string, { claim: Claim | null }>, me: string | null, now: number): string[] {
  const mine = [...tasks].filter(([, t]) => holderOf(t.claim, me, now) === 'mine')
  mine.sort(([a, x], [b, y]) => (y.claim!.claimedAt ?? 0) - (x.claim!.claimedAt ?? 0) || a.localeCompare(b))
  return mine.map(([key]) => key)
}

/** The colours a held key is painted in: the names `/color` takes. The order is part of the mapping. */
export const HELD_COLORS: readonly string[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

/** The colour of one key, the same in every session: FNV-1a of the key, modulo the list. */
export function heldColor(key: string): string {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return HELD_COLORS[(h >>> 0) % HELD_COLORS.length]!
}

/** What the footer label ends with while this session holds tasks: ` ◆ ZCC-7` in the key's colour, then ` +N` dim. */
export function footerClaimSpans(held: readonly string[]): { s: string; color?: string }[] {
  if (held.length === 0) {
    return []
  }
  const out: { s: string; color?: string }[] = [{ s: ` ${HOLDER_MARK.mine} ${held[0]}`, color: heldColor(held[0]!) }]
  if (held.length > 1) {
    out.push({ s: ` +${held.length - 1}` })
  }
  return out
}

/** A claim is warned about this long before it runs out. */
export const WARN_LEAD_MAX_MS = 5 * 60_000
/** A lease shorter than 50 minutes is warned at this share of it before it runs out: 3 minutes for a 30 minute lease. */
export const WARN_LEAD_LEASE_SHARE = 0.1

/** The `lease_ms` of a task's `claim` object as the CLI prints it. Null when absent or not a number. */
export function leaseOf(v: unknown): number | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  const lease = ms((v as Record<string, unknown>)['lease_ms'])
  return lease !== null && lease > 0 ? lease : null
}

/** How long before expiry a claim of this lease is warned about. A lease the CLI did not give gets the longest lead. */
export function warnLeadMs(leaseMs: number | null): number {
  return leaseMs === null ? WARN_LEAD_MAX_MS : Math.min(WARN_LEAD_MAX_MS, leaseMs * WARN_LEAD_LEASE_SHARE)
}

/** A claim runs out soon (`expiring`) or has run out (`expired`). `at` is the moment it falls due. */
export type ClaimAlert = { kind: 'expiring' | 'expired'; key: string; expiresAt: number; at: number }

/** One alert, once: it is named by its kind, key and expiry, so a renewed claim is warned about again. */
export const alertId = (a: Pick<ClaimAlert, 'kind' | 'key' | 'expiresAt'>): string => `${a.kind}:${a.key}:${a.expiresAt}`

/**
 * The alerts for this session's own claims, soonest first: a warning ahead of each claim that is still live,
 * and a notice for one that has run out. An expiry before `since` is not news, so it gets no notice. Alerts
 * named in `done` are left out. Empty when `me` is unknown.
 */
export function alertsFor(
  tasks: ReadonlyMap<string, { claim: Claim | null; leaseMs: number | null }>,
  me: string | null,
  now: number,
  since: number,
  done: ReadonlySet<string>,
): ClaimAlert[] {
  const out: ClaimAlert[] = []
  for (const [key, t] of tasks) {
    const c = t.claim
    if (me === null || c === null || c.sessionId !== me || c.expiresAt === null) {
      continue
    }
    const ranOut = c.state === 'expired' || c.expiresAt <= now
    const candidates: ClaimAlert[] = []
    if (!ranOut) {
      candidates.push({ kind: 'expiring', key, expiresAt: c.expiresAt, at: c.expiresAt - warnLeadMs(t.leaseMs) })
    }
    if (!ranOut || c.expiresAt >= since) {
      candidates.push({ kind: 'expired', key, expiresAt: c.expiresAt, at: c.expiresAt })
    }
    out.push(...candidates.filter((a) => !done.has(alertId(a))))
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
}

/** The alerts already due at `now`. */
export const dueAlerts = (alerts: readonly ClaimAlert[], now: number): ClaimAlert[] => alerts.filter((a) => a.at <= now)

/** The moment the next alert not yet due falls due. Null when there is none. */
export function nextAlertAt(alerts: readonly ClaimAlert[], now: number): number | null {
  const later = alerts.filter((a) => a.at > now)
  return later.length === 0 ? null : Math.min(...later.map((a) => a.at))
}

/** `zinn: this session's claim on ABC-7 expires at 14:30`, or `expired at 14:30`. */
export function alertText(a: ClaimAlert, now: number): string {
  return `zinn: this session's claim on ${a.key} ${a.kind === 'expiring' ? 'expires' : 'expired'} at ${wallTime(a.expiresAt, now)}`
}

/** What the person reads as the session ends while it still holds tasks, at most `max` of them, then `+N more`. */
export function endNoticeText(
  held: readonly string[],
  tasks: ReadonlyMap<string, { claim: Claim | null }>,
  now: number,
  max = 3,
): string {
  const shown = held.slice(0, max).map((key) => {
    const at = tasks.get(key)?.claim?.expiresAt ?? null
    return at === null ? key : `${key} (until ${wallTime(at, now)})`
  })
  const more = held.length - shown.length
  return `zinn: this session still holds ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`
}

/** The earliest moment after `now` at which one of these live claims runs out. Null when none will. */
export function nextExpiry(claims: Iterable<Claim | null>, now: number): number | null {
  let next: number | null = null
  for (const c of claims) {
    if (c !== null && c.state === 'live' && c.expiresAt !== null && c.expiresAt > now && (next === null || c.expiresAt < next)) {
      next = c.expiresAt
    }
  }
  return next
}

/**
 * Keys of `watched` that another session holds in `next` but did not hold in `prev`: newly claimed, taken over
 * from this session, or passed from one other session to another. Never this session's own claim.
 */
export function claimedAway(
  prev: ReadonlyMap<string, { claim: Claim | null }>,
  next: ReadonlyMap<string, { claim: Claim | null }>,
  watched: Iterable<string>,
  me: string | null,
  now: number,
): string[] {
  const out: string[] = []
  for (const key of watched) {
    const b = next.get(key)?.claim ?? null
    if (holderOf(b, me, now) !== 'theirs') {
      continue
    }
    const a = prev.get(key)?.claim ?? null
    const sameHolder = holderOf(a, me, now) === 'theirs' && a!.sessionId === b!.sessionId
    if (!sameHolder) {
      out.push(key)
    }
  }
  return out
}

/** `zinn: ABC-7 claimed by another session`, at most `max` keys, then `+N more`. */
export function claimToastText(keys: readonly string[], max = 3): string {
  const shown = keys.slice(0, max)
  const more = keys.length - shown.length
  return `zinn: ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''} claimed by another session`
}
