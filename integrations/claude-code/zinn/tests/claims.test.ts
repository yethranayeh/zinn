// Who holds a task: the claim as the CLI prints it, drawn in the legend, the board and the task pane. Pure.
import { test, expect } from 'claude-code/testing'
import { claimedAway, claimLine, claimOf, holderOf, legendClaim, nextExpiry, wallTime, type Claim } from '../lib/claims'
import { findMentions, parseTaskList } from '../lib/keys'
import { HELD_TITLE_MIN, underLines } from '../lib/plan'
import { lineText } from '../lib/style'
import { parseBoard } from '../lib/pane/board'
import { parseTask } from '../lib/pane/task'
import { layoutRows, rowText } from '../lib/pane/layouts'
import { boardRows } from '../lib/pane/views'
import { LAYOUTS } from '../lib/pane/resolve'
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
