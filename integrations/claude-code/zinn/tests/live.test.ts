// The live key map. The mod loaded by the engine's own host, a stubbed world beneath
// it: `tool.call` answers a fixed result, `process.run` answers `zinn` from a function, the clock is the kit's
// mocked clock. No store, no model, no session. Not covered here: a real session.
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ROWS } from './fixtures'
import type { KeyMapState } from '../lib/state'
import { classify } from '../lib/watch'

const SESSION = 'b7e1c0de-0000-4000-8000-000000000007'
const RUNNING = '2.1.296'
const MAP_NAME = { plugin: 'zinn', key: 'map' } as const
const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const CORE = { result: { stdout: 'core said this', stderr: '', interrupted: false } as never, text: 'core said this' }

type Run = { exitCode: number; stdout: string; stderr?: string }
type Live = {
  runs: string[][]; toasts: string[]; toolsSeen: string[]; map: () => KeyMapState | undefined; clock: ReturnType<typeof mock.clock>
  activity: { id: string }; view: Record<string, Run>
}

const listRuns = (w: Live): number => w.runs.filter(a => a[1] === 'task' && a[2] === 'list').length
const viewRuns = (w: Live): string[][] => w.runs.filter(a => a[1] === 'task' && a[2] === 'view')
const activityRuns = (w: Live): number => w.runs.filter(a => a[1] === 'activity').length
const viewOf = (key: string, column: string): Run => ({ exitCode: 0, stdout: JSON.stringify({ key, status: 'Active', column, title: 'Keep the key map live' }) })

function world(on: On): Live {
  const w: Live = { runs: [], toasts: [], toolsSeen: [], map: () => undefined, clock: undefined as never, activity: { id: 'a-1' }, view: {} }
  w.clock = mock.clock(on, { now: Date.UTC(2026, 9, 19, 9, 0, 0) })
  mock.env(on, {})
  let published: KeyMapState | undefined
  let version = 0
  w.map = () => published
  on('state.set', MAP_NAME, async (_$, e) => { published = e.value as KeyMapState; version += 1; return { value: { isSet: true as const, version } } })
  on('state.get', MAP_NAME, async () => ({ value: { value: published, version } }))
  on('session.version', async () => ({ value: { version: RUNNING, base: RUNNING } }))
  on('session.id', async () => ({ value: SESSION }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const res = (r: Run) => ({ value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'claude') {
      return res({ exitCode: 0, stdout: `${RUNNING} (Claude Code)\n` })
    }
    if (argv[1] === 'activity') {
      return res({ exitCode: 0, stdout: JSON.stringify([{ id: w.activity.id }]) })
    }
    if (argv[1] === 'task' && argv[2] === 'view') {
      return res(w.view[argv[3]!] ?? { exitCode: 1, stdout: '', stderr: '{"error":{"code":"storage","message":"boom"}}' })
    }
    if (argv[1] === 'task' && argv[2] === 'list') {
      return res({ exitCode: 0, stdout: JSON.stringify(ROWS) })
    }
    return res({ exitCode: 127, stdout: '', stderr: 'unknown' })
  })
  on('fs.exists', async () => ({ value: false }))
  on('fs.read', async () => ({ value: '' }))
  on('fs.write', async () => ({ value: undefined }))
  on('ui.render', async (_$, e) => ({ type: 'Text', props: {}, children: [String((e.props as { text?: string }).text ?? '')] }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('tool.call', async (_$, e) => { w.toolsSeen.push(String((e as { command?: unknown }).command ?? '')); return CORE })
  return w
}

async function settle(w: Live): Promise<void> {
  for (let i = 0; i < 6; i++) await w.clock.advance(10)
}

const BASE = { options: { look: 'under', pollSeconds: 30 } }

test('classify: write verbs name their keys', () => {
  expect(classify('zinn task move ZCC-7 Review')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task move ZCC-7 ZCC-8 "In Progress"')).toEqual({ kind: 'keys', keys: ['ZCC-7', 'ZCC-8'] })
  expect(classify('zinn task edit ZCC-7 --title "x y"')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task archive ZCC-7')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task unarchive ZCC-7')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task delete ZCC-7 --yes')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task rm ZCC-7 --yes')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task comment new ZCC-7 --text hi')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task comment rm ZCC-7 abc')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task relation new ZCC-7 --related ZCC-8')).toEqual({ kind: 'keys', keys: ['ZCC-7', 'ZCC-8'] })
  expect(classify("zinn task comment create ZCC-7 --text 'it costs $5'")).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task comment add ZCC-7 --text hi')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('zinn task label add ZCC-7 Research')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
  expect(classify('cd /x && zinn task move ZCC-7 Done && zinn task view ZCC-7 --json | jq .')).toEqual({ kind: 'keys', keys: ['ZCC-7'] })
})

test('classify: whole-board writes, unknown verbs and unreadable commands are a full refresh', () => {
  for (const c of [
    'zinn task create ZCC --title x', 'zinn task new ZCC --title x', 'zinn project new NEW', 'zinn project rm ZCC --yes', 'zinn label new bug', 'zinn label rm bug',
    'zinn project column new ZCC Review', 'zinn task ls2 ZCC', 'zinn project create NEW', 'zinn project delete ZCC --yes', 'zinn label create bug',
    'zinn restore x', 'zinn task frobnicate ZCC-7', 'zinn task move $KEY Done', 'zinn task move $(zinn task list ZCC --json | jq -r .[0].key) Done',
    'zinn task move ZCC-7 "Done', 'ZINN_DIR=/tmp/x zinn task move ZCC-7 Done', 'bash -c "zinn task move ZCC-7 Done"', 'xargs zinn task move',
    'zinn task move Done', 'cat <<EOF\nzinn task view ZCC-7\nEOF', 'zinn task view `echo ZCC-7`',
  ]) expect(classify(c).kind, c).toBe('full')
})

test('classify: reads, help and other programs are nothing', () => {
  for (const c of [
    'zinn task view ZCC-7 --json', 'zinn task list ZCC --json | jq .', 'zinn task search "move" ZCC', 'zinn project list', 'zinn project view ZCC',
    'zinn task comment list ZCC-7', 'zinn task relation list ZCC-7', 'zinn activity list --limit 5', 'zinn info --json', 'zinn -v', 'zinn task move --help',
    'zinn backup', 'zinn whoami', 'zinn whoami --json', 'zinn label list', 'zinn label view x', 'zinn label show x', 'zinn label ls',
    'zinn task show ZCC-7', 'zinn task ls ZCC', 'zinn project ls', 'zinn project show ZCC', 'zinn activity ls', 'zinn activity show x', 'zinn task comment ls ZCC-7',
    'zinn task comment show ZCC-7 x', 'zinn task relation ls ZCC-7', 'zinn project column ls ZCC', 'ls -la', 'git status && grep -n zinn AGENTS.md', 'echo "zinn is a tool"', '', 'zinn task view ZCC-7 --json 2>/dev/null',
  ]) expect(classify(c).kind, c).toBe('none')
})

test('write through Bash: the affected key is refreshed after the hook; the call and its result are untouched', BASE, async ($, on) => {
  const w = world(on)
  w.view['ZCC-7'] = viewOf('ZCC-7', 'Review')
  await $.session.start(START)
  expect(w.map()?.keys['ZCC-7']?.column).toBe('Blocked')
  const lists = listRuns(w)
  const command = 'zinn task move ZCC-7 Review'
  const r = await $.tool.call({ tool: 'Bash', command, description: 'move' } as never)
  expect((r as { text?: string }).text).toBe('core said this')
  expect((r as { result?: unknown }).result).toEqual(CORE.result)
  expect(w.toolsSeen).toEqual([command]) // the command reached the engine exactly as written
  await settle(w)
  expect(viewRuns(w)).toEqual([['zinn', 'task', 'view', 'ZCC-7', '--json']])
  expect(listRuns(w)).toBe(lists) // a partial refresh, not a reload
  expect(w.map()?.keys['ZCC-7']?.column).toBe('Review')
  expect(w.map()?.keys['ZCC-6']?.column).toBe('In Progress') // the rest is as it was
})

test('the hook returns before the refresh runs (the host is not held)', BASE, async ($, on) => {
  const w = world(on)
  w.view['ZCC-7'] = viewOf('ZCC-7', 'Review')
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'zinn task move ZCC-7 Review' } as never)
  expect(viewRuns(w).length).toBe(0) // the timer has not fired yet
  await settle(w)
  expect(viewRuns(w).length).toBe(1)
})

test('a deleted task leaves the map; an unreadable view falls back to a full reload', BASE, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.view['ZCC-8'] = { exitCode: 1, stdout: '', stderr: '{"error":{"code":"not_found","details":{"entity":"task","key":"ZCC-8"},"message":"gone"}}' }
  await $.tool.call({ tool: 'Bash', command: 'zinn task delete ZCC-8 --yes' } as never)
  await settle(w)
  expect(w.map()?.keys['ZCC-8']).toBe(undefined)
  const lists = listRuns(w)
  await $.tool.call({ tool: 'Bash', command: 'zinn task edit ZCC-7 --title x' } as never) // view answers a storage error
  await settle(w)
  expect(listRuns(w)).toBe(lists + 1)
  expect(w.map()?.keys['ZCC-8']?.column).toBe('TODO') // the full reload is the store's truth (the stub still lists it)
})

test('read-only zinn commands and other programs: no refresh at all', BASE, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const before = w.runs.length
  for (const command of ['zinn task view ZCC-7 --json', 'zinn task list ZCC --json | jq .', 'ls -la', 'git status && grep zinn AGENTS.md', 'zinn info']) {
    const r = await $.tool.call({ tool: 'Bash', command } as never)
    expect((r as { text?: string }).text).toBe('core said this')
  }
  await settle(w)
  expect(w.runs.length).toBe(before)
})

test('compound or unparseable command with a zinn write: full refresh', BASE, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const lists = listRuns(w)
  await $.tool.call({ tool: 'Bash', command: 'for k in ZCC-7 ZCC-8; do zinn task move $k Done; done' } as never)
  await settle(w)
  expect(listRuns(w)).toBe(lists + 1)
  expect(viewRuns(w).length).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'zinn project create NEW' } as never)
  await settle(w)
  expect(listRuns(w)).toBe(lists + 2)
})

test('poll: the id has not changed -> no refresh', BASE, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const lists = listRuns(w)
  const base = activityRuns(w)
  await w.clock.advance(30_000)
  await settle(w)
  await w.clock.advance(30_000)
  await settle(w)
  expect(activityRuns(w)).toBe(base + 2) // one cheap call per interval
  expect(listRuns(w)).toBe(lists)
})

test('poll: the id changed -> one full refresh, and the new id is remembered', BASE, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const lists = listRuns(w)
  w.activity.id = 'a-2'
  await w.clock.advance(30_000)
  await settle(w)
  expect(listRuns(w)).toBe(lists + 1)
  await w.clock.advance(30_000)
  await settle(w)
  expect(listRuns(w)).toBe(lists + 1) // same id again: nothing
})

test('pollSeconds 0: no timer and no activity call at all', { options: { look: 'under', pollSeconds: 0 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.activity.id = 'a-2'
  await w.clock.advance(300_000)
  await settle(w)
  expect(activityRuns(w)).toBe(0)
  expect(listRuns(w)).toBe(1)
})

test('toastOnChange: on by default, a column change says KEY -> Column', BASE, async ($, on) => {
  const w = world(on)
  w.view['ZCC-7'] = viewOf('ZCC-7', 'Review')
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'zinn task move ZCC-7 Review' } as never)
  await settle(w)
  expect(w.toasts).toEqual(['zinn: ZCC-7 -> Review'])
})

test('toastOnChange false: a column change toasts nothing', { options: { look: 'under', pollSeconds: 30, toastOnChange: false } }, async ($, on) => {
  const w = world(on)
  w.view['ZCC-7'] = viewOf('ZCC-7', 'Review')
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'zinn task move ZCC-7 Review' } as never)
  await settle(w)
  expect(w.toasts).toEqual([])
})

test('toastOnChange true (explicit)', { options: { look: 'under', pollSeconds: 30, toastOnChange: true } }, async ($, on) => {
  const w = world(on)
  w.view['ZCC-7'] = viewOf('ZCC-7', 'Review')
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'zinn task move ZCC-7 Review' } as never)
  await settle(w)
  expect(w.toasts).toEqual(['zinn: ZCC-7 -> Review'])
})

test('look off or enabled false: the hook does nothing', { options: { look: 'off', pollSeconds: 30 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const before = w.runs.length
  await $.tool.call({ tool: 'Bash', command: 'zinn task move ZCC-7 Review' } as never)
  await w.clock.advance(60_000)
  await settle(w)
  expect(w.runs.length).toBe(before)
})
