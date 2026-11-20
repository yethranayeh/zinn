// Who holds a task: the claim as the CLI prints it, drawn in the legend, the board and the task pane. Pure.
import { test, expect } from 'claude-code/testing'
import { alertsFor, alertText, claimedAway, claimLine, claimOf, dueAlerts, endNoticeText, END_RESERVE_MS, footerClaimSpans, heldColor, HELD_COLORS, holderOf, leaseOf, legendClaim, nextAlertAt, nextExpiry, releaseTimeoutMs, renewalsDue, renewFailText, wallTime, warnLeadMs, WARN_LEAD_MAX_MS, type Claim } from '../lib/claims'
import { findMentions, parseTaskList } from '../lib/keys'
import { HELD_TITLE_MIN, underLines } from '../lib/plan'
import { lineText } from '../lib/style'
import { parseBoard } from '../lib/pane/board'
import { parseTask } from '../lib/pane/task'
import { layoutRows, rowText } from '../lib/pane/layouts'
import { boardRows } from '../lib/pane/views'
import { LAYOUTS } from '../lib/pane/resolve'
import { readHeartbeat, readRelease } from '../lib/watch'
import { claimJson, HOUR } from './fixtures'
import { PROJECT, TASK } from './pane-fixtures'

const ME = 'b7e1c0de-0000-4000-8000-00000000c1a1'
const OTHER = 'other-session'
/** 2026-10-19T09:00:00Z. */
const NOW = Date.UTC(2026, 9, 19, 9, 0, 0)
const hm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

const ROWS = [
  { key: 'CLM-1', status: 'Active', column: 'Backlog', column_category: 'backlog', title: 'Mine', claim: claimJson(ME, NOW + HOUR) },
  { key: 'CLM-2', status: 'Active', column: 'Backlog', column_category: 'backlog', title: 'Theirs', claim: claimJson(OTHER, NOW + 30 * 60_000) },
  { key: 'CLM-3', status: 'Active', column: 'Backlog', column_category: 'backlog', title: 'Expired', claim: claimJson('gone', NOW - 60_000, 'expired') },
  { key: 'CLM-4', status: 'Active', column: 'Backlog', column_category: 'backlog', title: 'Free', claim: null },
  // Read as live, but its lease ran out since: expiry writes nothing to the store.
  { key: 'CLM-5', status: 'Active', column: 'Backlog', column_category: 'backlog', title: 'Ran out', claim: claimJson(OTHER, NOW - 1) },
]
const MAP = parseTaskList(JSON.stringify(ROWS))
const claim = (key: string): Claim | null => MAP.keys.get(key)!.claim

test('claim: parsed from the CLI row; no claim or an unknown shape is null', () => {
  expect(claim('CLM-1')).toEqual({ state: 'live', actorKind: 'agent', actorName: 'claude-code_2-1-327_agent', sessionId: ME, claimedAt: NOW - HOUR, expiresAt: NOW + HOUR })
  expect(claim('CLM-4')).toBeNull()
  expect(claimOf({ state: 'held' })).toBeNull()
  expect(claimOf(undefined)).toBeNull()
})

test('holder: mine by session id, theirs otherwise, expired by state or by the clock, none without a claim', () => {
  expect(['CLM-1', 'CLM-2', 'CLM-3', 'CLM-4', 'CLM-5'].map(k => holderOf(claim(k), ME, NOW))).toEqual(['mine', 'theirs', 'expired', null, 'expired'])
  expect(holderOf(claim('CLM-1'), null, NOW)).toBe('theirs') // this session's id unknown: nothing is mine
})

test('legend: yours (dim) or held (warning) until the local time; expired and free say nothing', () => {
  const text = 'CLM-1, CLM-2, CLM-3, CLM-4 and CLM-5'
  const lines = underLines(text, findMentions(text, MAP, { repeat: 'first', code: 'skip', only: null }), { marks: 'shapes', titleMax: 40 }, 'stacked', 0, { me: ME, now: NOW })
  expect(lines.map(lineText)).toEqual([
    `↳ CLM-1 ○ Mine · yours until ${hm(NOW + HOUR)}`,
    `↳ CLM-2 ○ Theirs · held until ${hm(NOW + 30 * 60_000)}`,
    '↳ CLM-3 ○ Expired',
    '↳ CLM-4 ○ Free',
    '↳ CLM-5 ○ Ran out',
  ])
  expect(legendClaim(claim('CLM-1'), ME, NOW)[0]!.style).toEqual({ dimColor: true })
  expect(legendClaim(claim('CLM-2'), ME, NOW)[0]!.style).toEqual({ color: 'warning' })
  // Without the claim context (the other looks), nothing about claims.
  expect(lineText(underLines(text, findMentions(text, MAP, { repeat: 'first', code: 'skip', only: null }), { marks: 'shapes', titleMax: 40 }, 'stacked', 0)[0]!)).toBe('↳ CLM-1 ○ Mine')
})

test('legend: a held entry cuts its title by the claim part, so it is no wider than a free one', () => {
  const long = 'A title long enough to fill the whole title budget of forty'
  const rows = [
    { key: 'CLM-1', status: 'Active', column: 'Backlog', column_category: 'backlog', title: long, claim: claimJson(OTHER, NOW + HOUR) },
    { key: 'CLM-2', status: 'Active', column: 'Backlog', column_category: 'backlog', title: long, claim: null },
  ]
  const text = 'CLM-1 and CLM-2'
  const legend = (titleMax: number): string[] => underLines(text, findMentions(text, parseTaskList(JSON.stringify(rows)), { repeat: 'first', code: 'skip', only: null }), { marks: 'shapes', titleMax }, 'stacked', 0, { me: ME, now: NOW }).map(lineText)
  const [held, free] = legend(40)
  expect(held).toContain(' · held until ')
  expect(held!.length).toBeLessThanOrEqual(free!.length)
  // A short titleMax still leaves the held entry a title.
  const [shortHeld] = legend(20)
  expect(shortHeld).toContain(`○ ${long.slice(0, HELD_TITLE_MIN - 1).trimEnd()}…`)
})

test('footer: the latest held key in its own colour, the same for a key every time, then +N dim', () => {
  expect(footerClaimSpans([])).toEqual([])
  expect(footerClaimSpans(['CLM-1', 'CLM-2', 'CLM-9'])).toEqual([{ s: ' ◆ CLM-1', color: heldColor('CLM-1') }, { s: ' +2' }])
  expect(HELD_COLORS).toContain(heldColor('CLM-1'))
  expect(new Set(['ZCC-1', 'ZCC-2', 'ZCC-3', 'ZCC-4', 'ZCC-5', 'ZCC-6', 'ZCC-7', 'ZCC-8'].map(heldColor)).size).toBeGreaterThan(1)
})

test('wall time: the time alone today, the date with it on another day', () => {
  expect(wallTime(NOW, NOW)).toBe(hm(NOW))
  expect(wallTime(NOW + 3 * 24 * HOUR, NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('board: ◆ for this session, ◇ for another, after the key; no cell on a board where nobody holds a task', () => {
  const tasks = ROWS.map(r => ({ ...r, is_first: true, is_last: false }))
  const b = parseBoard(JSON.stringify(PROJECT), JSON.stringify(tasks))
  const rows = boardRows(b, { width: 100, showAll: true, claims: { me: ME, now: NOW } }).map(rowText)
  const row = (key: string) => rows.find(r => r.includes(key))!
  expect(row('CLM-1')).toContain('CLM-1 ◆ │')
  expect(row('CLM-2')).toContain('CLM-2 ◇ │')
  for (const k of ['CLM-3', 'CLM-4', 'CLM-5']) expect(row(k)).toContain(`${k}   │`)
  const free = parseBoard(JSON.stringify(PROJECT), JSON.stringify(tasks.filter(t => t.key === 'CLM-4' || t.key === 'CLM-3')))
  expect(boardRows(free, { width: 100, showAll: true, claims: { me: ME, now: NOW } }).map(rowText).find(r => r.includes('CLM-4'))).toContain('CLM-4 │')
})

test('pane: one claim line in every layout, saying whose, since and until; an expired claim says so', () => {
  const at = (c: object | null) => parseTask(JSON.stringify({ ...TASK, claim: c }))
  for (const layout of LAYOUTS) {
    const text = (c: object | null) => layoutRows(layout, at(c), { width: 100, claims: { me: ME, now: NOW } }).map(rowText).join('\n')
    expect(text(claimJson(ME, NOW + HOUR))).toContain(`◆ this session · claude-code_2-1-327_agent (agent) · since ${hm(NOW - HOUR)} · until ${hm(NOW + HOUR)}`)
    expect(text(claimJson(OTHER, NOW + HOUR))).toContain('◇ another session')
    expect(text(claimJson(OTHER, NOW - 60_000, 'expired'))).toContain(`expired claim · claude-code_2-1-327_agent (agent) · since ${hm(NOW - 60_000 - 2 * HOUR)} · expired ${hm(NOW - 60_000)}`)
    expect(text(null)).not.toContain('claim')
    expect(text(null)).toBe(layoutRows(layout, at(null), { width: 100 }).map(rowText).join('\n'))
  }
  expect(claimLine(null, ME, NOW)).toBeNull()
})

test('expiry: the earliest live claim still to run out', () => {
  expect(nextExpiry([...MAP.keys.values()].map(i => i.claim), NOW)).toBe(NOW + 30 * 60_000)
  expect(nextExpiry([claim('CLM-3'), null], NOW)).toBeNull()
})

test('toast keys: a watched key another session newly holds or took over; never my own, never an unchanged holder', () => {
  const at = (rows: object[]) => parseTaskList(JSON.stringify(rows)).keys
  const free = at([{ key: 'CLM-9', title: 't', column: 'TODO', claim: null }, { key: 'CLM-8', title: 't', column: 'TODO', claim: claimJson(ME, NOW + HOUR) }, { key: 'CLM-7', title: 't', column: 'TODO', claim: claimJson(OTHER, NOW + HOUR) }])
  const later = at([{ key: 'CLM-9', title: 't', column: 'TODO', claim: claimJson(OTHER, NOW + HOUR) }, { key: 'CLM-8', title: 't', column: 'TODO', claim: claimJson(OTHER, NOW + HOUR) }, { key: 'CLM-7', title: 't', column: 'TODO', claim: claimJson(OTHER, NOW + 2 * HOUR) }])
  expect(claimedAway(free, later, ['CLM-9', 'CLM-8', 'CLM-7'], ME, NOW)).toEqual(['CLM-9', 'CLM-8']) // CLM-7: same holder, renewed
  expect(claimedAway(free, later, ['CLM-7'], ME, NOW)).toEqual([])
  expect(claimedAway(later, free, ['CLM-9', 'CLM-8'], ME, NOW)).toEqual([]) // released, or claimed by me
})

// ZCC-24: the notices about this session's own claims.
test('warning lead: 5 minutes, or a tenth of a lease shorter than 50 minutes', () => {
  expect(warnLeadMs(2 * HOUR)).toBe(WARN_LEAD_MAX_MS)
  expect(warnLeadMs(50 * 60_000)).toBe(WARN_LEAD_MAX_MS)
  expect(warnLeadMs(30 * 60_000)).toBe(3 * 60_000)
  expect(warnLeadMs(60_000)).toBe(6000)
  expect(warnLeadMs(null)).toBe(WARN_LEAD_MAX_MS)
  expect(leaseOf(claimJson(ME, NOW, 'live', 30 * 60_000))).toBe(30 * 60_000)
  expect(leaseOf({ state: 'live' })).toBeNull()
  expect(leaseOf(null)).toBeNull()
})

const held = (rows: object[]) => parseTaskList(JSON.stringify(rows)).keys
const row = (key: string, claim: object | null) => ({ key, title: 't', column: 'TODO', claim })

test('alerts: this session\'s live claim warns ahead and then expires; another session\'s never does', () => {
  const lease = 30 * 60_000
  const tasks = held([row('CLM-1', claimJson(ME, NOW + lease, 'live', lease)), row('CLM-2', claimJson(OTHER, NOW + lease, 'live', lease))])
  const alerts = alertsFor(tasks, ME, NOW, NOW, new Set())
  expect(alerts.map(a => [a.kind, a.key, a.at])).toEqual([['expiring', 'CLM-1', NOW + lease - 3 * 60_000], ['expired', 'CLM-1', NOW + lease]])
  expect(dueAlerts(alerts, NOW)).toEqual([])
  expect(nextAlertAt(alerts, NOW)).toBe(NOW + lease - 3 * 60_000)
  expect(dueAlerts(alerts, NOW + lease - 3 * 60_000).map(a => a.kind)).toEqual(['expiring'])
  expect(nextAlertAt(alerts, NOW + lease)).toBeNull()
  expect(alertsFor(tasks, null, NOW, NOW, new Set())).toEqual([]) // this session's id unknown: nothing is mine
})

test('alerts: one already given is left out, a renewed expiry is a new alert, a lapse before the start is no news', () => {
  const lease = 30 * 60_000
  const [first] = alertsFor(held([row('CLM-1', claimJson(ME, NOW + lease, 'live', lease))]), ME, NOW, NOW, new Set())
  const done = new Set([`expiring:CLM-1:${NOW + lease}`])
  expect(alertsFor(held([row('CLM-1', claimJson(ME, NOW + lease, 'live', lease))]), ME, NOW, NOW, done).map(a => a.kind)).toEqual(['expired'])
  expect(alertsFor(held([row('CLM-1', claimJson(ME, NOW + 2 * lease, 'live', lease))]), ME, NOW, NOW, done).map(a => a.kind)).toEqual(['expiring', 'expired'])
  expect(first!.kind).toBe('expiring')
  const lapsed = held([row('CLM-1', claimJson(ME, NOW - 60_000, 'expired'))])
  expect(alertsFor(lapsed, ME, NOW, NOW, new Set())).toEqual([])
  expect(alertsFor(lapsed, ME, NOW, NOW - 120_000, new Set()).map(a => [a.kind, a.at])).toEqual([['expired', NOW - 60_000]])
  // Read as live but already past its expiry by the clock: not a warning.
  expect(alertsFor(held([row('CLM-1', claimJson(ME, NOW - 1))]), ME, NOW, NOW - 60_000, new Set()).map(a => a.kind)).toEqual(['expired'])
})

test('notice texts: the key and the local time', () => {
  const [a] = alertsFor(held([row('CLM-1', claimJson(ME, NOW + HOUR))]), ME, NOW, NOW, new Set())
  expect(alertText(a!, NOW)).toContain('CLM-1')
  expect(alertText(a!, NOW)).toContain(hm(NOW + HOUR))
  const tasks = held([1, 2, 3, 4, 5].map(n => row(`CLM-${n}`, claimJson(ME, NOW + n * HOUR))))
  const text = endNoticeText([...tasks.keys()], tasks, NOW)
  expect(text).toContain(`CLM-1 (until ${hm(NOW + HOUR)})`)
  expect(text).toContain('+2 more')
  expect(text).not.toContain('CLM-4')
})


// ZCC-25: which of this session's claims a turn with tools renews, and how a heartbeat's answer reads.
test('renewalsDue: only this session\'s live claims with less than half the lease left', () => {
  const lease = 30 * 60_000
  const tasks = held([
    row('CLM-1', claimJson(ME, NOW + lease / 2 - 1, 'live', lease)),
    row('CLM-2', claimJson(ME, NOW + lease / 2, 'live', lease)),
    row('CLM-3', claimJson(OTHER, NOW + 60_000, 'live', lease)),
    row('CLM-4', claimJson(ME, NOW - 1, 'live', lease)),
    row('CLM-5', claimJson(ME, NOW + 60_000, 'expired', lease)),
    row('CLM-6', null),
    row('CLM-7', claimJson(ME, NOW + 60_000, 'live', lease)),
  ])
  expect(renewalsDue(tasks, ME, NOW, new Set())).toEqual(['CLM-1', 'CLM-7'])
  expect(renewalsDue(tasks, ME, NOW, new Set(['CLM-7']))).toEqual(['CLM-1'])
  expect(renewalsDue(tasks, null, NOW, new Set())).toEqual([])
  const { lease_ms: _, ...noLease } = claimJson(ME, NOW + 60_000, 'live', lease)
  expect(renewalsDue(held([row('CLM-8', noLease)]), ME, NOW, new Set())).toEqual([])
})

test('readHeartbeat: the renewed task, a refusal by reason or code, or no answer', () => {
  const task = { key: 'CLM-1', status: 'Active', column: 'TODO', title: 't', claim: claimJson(ME, NOW + HOUR), changed: true }
  const ok = readHeartbeat('CLM-1', { exitCode: 0, stdout: JSON.stringify(task), stderr: '' })
  expect(ok.kind).toBe('renewed')
  expect(ok.kind === 'renewed' ? ok.info.claim?.expiresAt : null).toBe(NOW + HOUR)
  for (const reason of ['claimed', 'claim_limit', 'not_claimed']) {
    const stderr = JSON.stringify({ error: { code: 'conflict', message: 'm', details: { entity: 'task', key: 'CLM-1', reason } } })
    expect(readHeartbeat('CLM-1', { exitCode: 1, stdout: '', stderr })).toEqual({ kind: 'refused', reason, message: 'm' })
  }
  const notFound = JSON.stringify({ error: { code: 'not_found', message: 'gone', details: { entity: 'task' } } })
  expect(readHeartbeat('CLM-1', { exitCode: 1, stdout: '', stderr: notFound })).toEqual({ kind: 'refused', reason: 'not_found', message: 'gone' })
  expect(readHeartbeat('CLM-1', { exitCode: 127, stdout: '', stderr: 'zinn: command not found' }).kind).toBe('failed')
  expect(readHeartbeat('CLM-1', { exitCode: 0, stdout: 'not json', stderr: '' }).kind).toBe('failed')
})

test('renewFailText names the key for every refusal', () => {
  for (const reason of ['claimed', 'claim_limit', 'not_claimed', 'not_found']) {
    expect(renewFailText('CLM-1', { reason, message: 'm' })).toContain('CLM-1')
  }
})

// ZCC-26: how long a release may run, and how a release's answer reads.
test('releaseTimeoutMs: what the bound leaves after the reserve, never past the cap, nothing when no time is left', () => {
  const cap = 5000
  expect(releaseTimeoutMs(1500, cap)).toBe(1500 - END_RESERVE_MS)
  expect(releaseTimeoutMs(1500.9, cap)).toBe(Math.floor(1500.9 - END_RESERVE_MS))
  expect(releaseTimeoutMs(10_000, cap)).toBe(cap)
  expect(releaseTimeoutMs(Infinity, cap)).toBe(cap) // nothing meters the bound
  expect(releaseTimeoutMs(END_RESERVE_MS, cap)).toBeNull()
  expect(releaseTimeoutMs(END_RESERVE_MS + 1, cap)).toBe(1)
  expect(releaseTimeoutMs(0, cap)).toBeNull()
})

test('readRelease: released whether or not a claim was there, a refusal by reason, or no answer', () => {
  const task = { key: 'CLM-1', status: 'Active', column: 'TODO', title: 't', claim: null }
  for (const changed of [true, false]) {
    expect(readRelease('CLM-1', { exitCode: 0, stdout: JSON.stringify({ ...task, changed }), stderr: '' })).toEqual({ kind: 'released' })
  }
  const stderr = JSON.stringify({ error: { code: 'conflict', message: 'm', details: { entity: 'task', key: 'CLM-1', reason: 'claimed', claimExpiresAt: NOW } } })
  expect(readRelease('CLM-1', { exitCode: 1, stdout: '', stderr })).toEqual({ kind: 'refused', reason: 'claimed', message: 'm' })
  expect(readRelease('CLM-1', { exitCode: 127, stdout: '', stderr: 'zinn: command not found' }).kind).toBe('failed')
  expect(readRelease('CLM-1', { exitCode: 0, stdout: 'not json', stderr: '' }).kind).toBe('failed')
  expect(readRelease('CLM-2', { exitCode: 0, stdout: JSON.stringify(task), stderr: '' }).kind).toBe('failed') // another task's answer
})
