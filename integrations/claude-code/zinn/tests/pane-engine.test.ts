// The pane loaded by the engine's own host, a stubbed world beneath it, on the
// terminal and desktop surfaces. `claude plugin test` calls no model. `process.run` is stubbed, so no
// store is touched. The kit exercises hooks, never a surface's paint: the colour, the
// seating width and the j-goes-back, q-closes keys are looked at live.
import { test, expect } from 'claude-code/testing'
import type { On, PluginOptions } from 'claude-code'
import { BARE, BOARD_TASKS, NOT_FOUND, PROJECT, PROJECTS, TASK } from './pane-fixtures'
import { VERSION } from '../hooks/client'

declare const console: { log: (...args: unknown[]) => void }

const SURFACES = ['terminal', 'desktop'] as const
type Zinn = { exitCode: number; stdout: string; stderr?: string } | 'throw'
type Seen = { kind: string; key: string; state: string; error?: string | null; tab?: string; showAll?: boolean }
type World = { runs: string[][]; toasts: string[]; opens: { id: string; title?: string; focus?: true; closeOnEscape?: true }[]; registered: string[]; immediate: boolean[]; closes: string[]; selection: { text: string } | undefined; view: () => { stack: Seen[]; layout: string | null } | undefined; raw: () => unknown; seed: (value: unknown) => void; locked: boolean; envs: (Record<string, string> | undefined)[] }

function world(on: On, o: { task?: Zinn; board?: Zinn; projects?: Zinn; selection?: string; env?: Record<string, string>; placed?: boolean } = {}): World {
  const w: World = { runs: [], toasts: [], opens: [], registered: [], immediate: [], closes: [], selection: o.selection === undefined ? undefined : { text: o.selection }, view: () => undefined, raw: () => undefined, seed: () => undefined, locked: false, envs: [] }
  // The test is the state store. The mod keeps its value under a shape tag (`{ shape, value }`, the engine's Shaped).
  let stored: unknown
  let version = 0
  w.raw = () => stored
  w.seed = value => { stored = value; version += 1 }
  w.view = () => (stored as { value?: ReturnType<World['view']> } | undefined)?.value
  const REF = { plugin: 'zinn', key: 'view' } as const
  on('state.set', REF, async (_$, e) => { stored = e.value; version += 1; return { value: { isSet: true as const, version } } })
  on('state.get', REF, async () => ({ value: { value: stored, version } }))
  on('ui.toast', async (_$, e) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('ui.log', async () => ({ value: undefined }))
  // The plugin also registers /zinn for its transcript part. These tests count the pane's command only.
  on('command.register', async (_$, e) => {
    if (e.name === 'zinn-show') {
      w.registered.push(e.name)
      w.immediate.push(e.immediate === true)
    }
    return { value: { command: e.name } }
  })
  on('ui.close', async (_$, e) => { w.closes.push(e.id); return { value: undefined } })
  on('ui.selection', async () => ({ value: w.selection }))
  on('ui.open', async (_$, e) => {
    w.opens.push({ id: e.id, ...(e.title !== undefined ? { title: e.title } : {}), ...(e.focus ? { focus: true as const } : {}), ...(e.closeOnEscape ? { closeOnEscape: true as const } : {}) })
    return { value: o.placed === false ? { isPlaced: false as const, reason: 'no surface' } : { isPlaced: true as const } }
  })
  const answer = (z: Zinn) => {
    if (z === 'throw') {
      throw new Error('spawn zinn ENOENT')
    }
    return { value: { exitCode: z.exitCode, stdout: z.stdout, stderr: z.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    // The transcript part's own reads at session start are answered and not recorded: these tests are about the pane.
    if (argv[0] === 'claude') {
      return answer({ exitCode: 0, stdout: '2.1.326 (Claude Code)\n' })
    }
    if (argv[1] === 'activity' || (argv[2] === 'list' && argv[3] === '--all')) {
      return answer({ exitCode: 0, stdout: '[]' })
    }
    w.runs.push(argv)
    w.envs.push(e.init?.env)
    if (w.locked) {
      return answer({ exitCode: 1, stdout: '', stderr: '{"error":{"code":"storage","message":"database is locked"}}' })
    }
    if (argv[0] === 'zinn' && argv[1] === 'project' && argv[2] === 'list') {
      return answer(o.projects ?? { exitCode: 0, stdout: JSON.stringify(PROJECTS) })
    }
    if (argv[0] === 'zinn' && (argv[1] === 'project' || argv[2] === 'list')) {
      // A board: `project view KEY` and `task list KEY`.
      if (o.board !== undefined) {
        return answer(o.board)
      }
      if (argv[3] !== 'ZCC') {
        return answer({ exitCode: 1, stdout: '', stderr: NOT_FOUND(`Project ${argv[3]}`) })
      }
      return answer({ exitCode: 0, stdout: JSON.stringify(argv[1] === 'project' ? PROJECT : BOARD_TASKS) })
    }
    if (argv[0] === 'zinn' && argv[2] === 'view') {
      const z = o.task
      if (z !== undefined) {
        return answer(z)
      }
      if (argv[3] === 'ZCC-8') {
        return answer({ exitCode: 0, stdout: JSON.stringify(TASK) })
      }
      if (argv[3] === 'ZCC-1') {
        return answer({ exitCode: 0, stdout: JSON.stringify(BARE) })
      }
      if (argv[3] === 'ZCC-9' || argv[3] === 'ZCC-6') {
        return answer({ exitCode: 0, stdout: JSON.stringify({ ...BARE, key: argv[3], status: 'Active' }) })
      }
      return answer({ exitCode: 1, stdout: '', stderr: NOT_FOUND(`Task ${argv[3]}`) })
    }
    return answer({ exitCode: 127, stdout: '', stderr: 'unknown' })
  })
  const env = o.env ?? {}
  on('env.get', async (_$, e) => ({ value: env[e.name] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return w
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const VIEW = { columns: 100, rows: 40, isFullscreen: true } as const
const RUN = (args: string) => ({ command: 'zinn-show', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as const
const opts = (o: PluginOptions): { options: PluginOptions } => ({ options: o })
const PANE_PROPS = { title: 'ZCC-8', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 30 }, view: {} } as never
const text = (tree: unknown): string => JSON.stringify(tree)
const names = (w: World): string[] => (w.view()?.stack ?? []).map(x => `${x.kind}:${x.key}:${x.state}`)
const mount = ($: { ui: { mount: (a: never) => Promise<unknown> } }, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: 'zinn', surface, component: 'Pane', requestId: 'zinn-show', props: PANE_PROPS, viewport: VIEW } as never) as Promise<{ drawn: () => Promise<unknown>; press: (a: { key: string }) => Promise<unknown>; find: (a: { key: string }) => Promise<{ text?: string } | undefined>; unmount: () => Promise<void> }>

test('session.start registers /zinn-show, nothing else, and reads no store', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.registered).toEqual(['zinn-show'])
  expect(w.immediate).toEqual([true]) // runs mid-turn, so a press does not wait for the turn
  expect(w.runs).toEqual([])
})

test('ZCC-2 /zinn-show declares the pane in ZINN_CLIENT after the inherited chain', opts({}), async ($, on) => {
  const w = world(on, { env: { ZINN_CLIENT: ' rex/0.9 ' } })
  await $.session.start(START)
  await $.command.run(RUN('ZCC'))
  expect(w.runs.length).toBeGreaterThan(1)
  expect(w.envs).toEqual(w.runs.map(() => ({ ZINN_CLIENT: `rex/0.9 zinn-claude-code:pane/${VERSION}` })))
})

test('pane off: no /zinn-show is registered', opts({ pane: false }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.registered).toEqual([])
})

test('/zinn-show KEY: argv only, the pane opens with no Esc handling, the answer has no text', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const r = await $.command.run(RUN('ZCC-8'))
  expect(r.text).toBeUndefined()
  expect(r.context).toBeUndefined()
  expect(w.runs).toEqual([['zinn', 'task', 'view', 'ZCC-8', '--json']])
  expect(w.opens).toEqual([{ id: 'zinn-show', title: 'ZCC-8', focus: true }]) // no closeOnEscape
  expect(names(w)).toEqual(['task:ZCC-8:ready'])
  expect((w.raw() as { shape?: string }).shape).toBe('view-4') // kept under the shape tag
  expect(w.toasts).toEqual([])
})

test('no argument: the first key of the selection that the store has; the list of all keys is never read', opts({}), async ($, on) => {
  const w = world(on, { selection: 'blocked by SHA-256, then see ZCC-8 and ZCC-6' })
  await $.session.start(START)
  await $.command.run(RUN(''))
  // SHA-256 is key-shaped: the CLI says not_found, and the next word is tried.
  expect(w.runs).toEqual([['zinn', 'task', 'view', 'SHA-256', '--json'], ['zinn', 'task', 'view', 'ZCC-8', '--json']])
  expect(names(w)).toEqual(['task:ZCC-8:ready'])
  expect(w.toasts).toEqual([])
})

test('no argument, nothing selected: the list of boards, one read; a press opens a board, a press there opens a task', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const r = await $.command.run(RUN(''))
  expect(r.text).toBeUndefined()
  expect(w.runs).toEqual([['zinn', 'project', 'list', '--json']])
  expect(w.opens).toEqual([{ id: 'zinn-show', title: 'boards', focus: true }])
  const ui = await mount($)
  const t = text(await ui.drawn())
  for (const must of ['Boards', 'SAM', 'Sandboxes', '31 active', 'ZCC', 'TS']) expect(t).toContain(must)
  expect(t).toContain('back (closes)')
  await ui.press({ key: 'open:ZCC' })
  expect(w.runs.slice(1).sort()).toEqual([['zinn', 'project', 'view', 'ZCC', '--json'], ['zinn', 'task', 'list', 'ZCC', '--json']])
  expect(names(w)).toEqual(['projects:*:ready', 'board:ZCC:ready'])
  await ui.unmount()
  const board = await mount($)
  const b = text(await board.drawn())
  for (const must of ['Claude Code mods', '14 open', '7 closed', 'Backlog', 'TODO', 'In Progress', 'Done', 'Task detail pane', 'back to boards', 'all tasks']) expect(b).toContain(must)
  expect(b).not.toContain('"boards"]') // no `p: boards` button: the list is already one step back
  await board.press({ key: 'open:ZCC-8' })
  expect(names(w)).toEqual(['projects:*:ready', 'board:ZCC:ready', 'task:ZCC-8:ready'])
  await board.unmount()
  const task = await mount($)
  expect(text(await task.drawn())).toContain('back to ZCC board (2 behind)')
  await task.press({ key: 'nav:back' })
  await task.press({ key: 'nav:back' })
  expect(names(w)).toEqual(['projects:*:ready'])
  expect(w.toasts).toEqual([])
  await task.unmount()
})

test('/zinn-show PROJECT: its board, two reads side by side; `a` shows every task; an unknown project is a toast', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('zcc'))
  expect(w.opens).toEqual([{ id: 'zinn-show', title: 'ZCC board', focus: true }])
  expect(names(w)).toEqual(['board:ZCC:ready'])
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const t = text(await ui.drawn())
    expect(t).toContain('… 2 more')
    expect(t).toContain('ZCC-206')
    expect(t).not.toContain('ZCC-200') // the oldest done task is under the cut
    await ui.unmount()
  }
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'nav:all' })
  expect(w.view()?.stack[0]?.showAll).toBe(true)
  await ui.unmount()
  const all = await mount($)
  const t = text(await all.drawn())
  expect(t).toContain('ZCC-200')
  expect(t).toContain('fewer')
  await all.press({ key: 'nav:boards' }) // up to the list of boards
  expect(names(w)).toEqual(['board:ZCC:ready', 'projects:*:ready'])
  await all.unmount()
  await $.command.run(RUN('NOPE'))
  expect(w.toasts).toEqual(['zinn-show: NOPE board: exit 1: Project NOPE not found'])
  expect(w.opens).toHaveLength(1)
})

test('a selection with no key, and one with an unknown key: a message, no pane', opts({}), async ($, on) => {
  const w = world(on, { selection: 'just words' })
  await $.session.start(START)
  await $.command.run(RUN(''))
  w.selection = { text: 'ZCC-99' }
  await $.command.run(RUN(''))
  expect(w.toasts).toEqual(['zinn-show: no Zinn task key in the selection', 'zinn-show: ZCC-99 is not a task in the store'])
  expect(w.opens).toEqual([])
})

test('a selection that is one project key opens its board', opts({}), async ($, on) => {
  const w = world(on, { selection: 'ZCC' })
  await $.session.start(START)
  await $.command.run(RUN(''))
  expect(names(w)).toEqual(['board:ZCC:ready'])
})

test('unknown key typed: a toast with the CLI reason, no pane; nothing throws', opts({ layout: 'card' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC-99'))
  expect(w.opens).toEqual([])
  expect(w.view()?.stack ?? []).toEqual([])
  expect(w.toasts).toEqual(['zinn-show: ZCC-99: exit 1: Task ZCC-99 not found'])
})

test('a word that is neither: a toast that names the three things it could be', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('--help'))
  expect(w.toasts).toEqual(['zinn-show: "--help" is not a task key, a project key or a layout (card, sectioned, table)'])
  expect(w.runs).toEqual([])
})

test('zinn fails to run: no crash, no pane, a toast that says so; a store failure ends the search of a selection', opts({}), async ($, on) => {
  const w = world(on, { task: 'throw', projects: 'throw', board: 'throw' })
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  await $.command.run(RUN(''))
  await $.command.run(RUN('ZCC'))
  expect(w.opens).toEqual([])
  // A test hook that throws is skipped by the kit, so the mod sees the kit's own "no implementation" rejection:
  // the same branch as a real ENOENT (zinn not on PATH).
  expect(w.toasts.map(t => t.replace(/(did not run): .*/, '$1'))).toEqual(['zinn-show: ZCC-8: zinn did not run', 'zinn-show: boards: zinn did not run', 'zinn-show: ZCC board: zinn did not run'])
  w.selection = { text: 'ZCC-8 ZCC-6 ZCC-1' }
  const before = w.runs.length
  await $.command.run(RUN(''))
  expect(w.runs.length - before).toBe(1) // not "no such task": the other words are not tried
  expect(w.toasts.at(-1)).toContain('zinn-show: ZCC-8: zinn did not run')
})

test('a pane that cannot be placed says so in a toast', opts({}), async ($, on) => {
  const w = world(on, { placed: false })
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  expect(w.toasts).toEqual(['zinn-show: pane waits undrawn (no surface)'])
})

for (const layout of ['card', 'sectioned', 'table'] as const) {
  test(`layout ${layout}: the pane draws every field of the real task, on both surfaces`, opts({ layout }), async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run(RUN('ZCC-8'))
    expect(w.view()?.stack[0]?.state).toBe('ready')
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      const t = text(await ui.drawn())
      if (surface === 'terminal' && layout === 'card') {
        console.log('card tree:', t.slice(0, 600))
      }
      for (const must of ['ZCC-8', 'Task detail pane', 'In Progress', 'medium', 'frontend', 'ZCC-6', 'ZCC-9', 'ZCC-16', 'modal']) expect(t).toContain(must)
      expect(/2 comments|Comments {2}.*\"2\"/.test(t)).toBe(true)
      await ui.unmount()
    }
  })
}

test('layout from the variable, and switched live by /zinn-show LAYOUT; a relation button opens that task', opts({}), async ($, on) => {
  const w = world(on, { env: { ZINN_TASK_PANE_LAYOUT: 'table' } })
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  expect(w.view()?.layout).toBeNull() // nothing chosen in the pane yet: the variable decides
  await $.command.run(RUN('card'))
  expect(w.view()?.layout).toBe('card')
  expect(w.runs).toHaveLength(1) // the layout alone reads nothing and opens nothing new
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'open:ZCC-9' })
  expect(w.runs.at(-1)).toEqual(['zinn', 'task', 'view', 'ZCC-9', '--json'])
  expect(w.view()?.stack.map(x => x.key)).toEqual(['ZCC-8', 'ZCC-9'])
  await ui.unmount()
})

test('the three pages of a task: overview, the whole description, the comments newest first; the layout switch shows on the overview only', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  const ui = await mount($)
  const over = text(await ui.drawn())
  expect(over).toContain('sectioned') // the layout switch
  expect(over).not.toContain('meta.agent')
  await ui.press({ key: 'tab:description' })
  expect(w.view()?.stack[0]?.tab).toBe('description')
  await ui.unmount()
  const d = await mount($)
  const desc = text(await d.drawn())
  expect(desc).toContain('meta.agent: sonnet (medium)') // whole: the assignment footer too
  expect(desc).toContain('"type":"Markdown"')
  expect(desc).not.toContain('sectioned')
  await d.press({ key: 'tab:comments' })
  await d.unmount()
  const c = await mount($)
  const com = text(await c.drawn())
  expect(com.indexOf('ZCC-8#2') < com.indexOf('ZCC-8#1')).toBe(true)
  expect(com).toContain('2026-10-13')
  expect(com).toContain('Agent picked `table`.')
  expect(w.runs).toHaveLength(1) // a page is drawn from what is held: no read
  await c.unmount()
})

test('b goes up to the task\'s board; r reads the top again and keeps the page; a failed re-read keeps what is drawn', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'tab:comments' })
  await ui.press({ key: 'nav:refresh' })
  expect(w.runs).toEqual([['zinn', 'task', 'view', 'ZCC-8', '--json'], ['zinn', 'task', 'view', 'ZCC-8', '--json']])
  expect(w.view()?.stack[0]?.tab).toBe('comments')
  expect(w.toasts).toEqual(['zinn-show: ZCC-8 re-read'])
  await ui.press({ key: 'nav:board' })
  expect(names(w)).toEqual(['task:ZCC-8:ready', 'board:ZCC:ready'])
  await ui.unmount()
})

test('a failed re-read: a toast, and the entry stays ready', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  w.locked = true
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'nav:refresh' })
  expect(w.toasts).toEqual(['zinn-show: ZCC-8 not re-read: exit 1: database is locked'])
  expect(names(w)).toEqual(['task:ZCC-8:ready'])
  await ui.unmount()
})

test('a relation that cannot be loaded settles inside the pane, with the reason', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  const ui = await mount($)
  await ui.drawn()
  await ui.press({ key: 'open:ZCC-16' }) // the stub has no ZCC-16
  expect(names(w)).toEqual(['task:ZCC-8:ready', 'task:ZCC-16:failed'])
  await ui.unmount()
  const again = await mount($)
  const t = text(await again.drawn())
  expect(t).toContain('Task ZCC-16 not found')
  expect(t).toContain('back to ZCC-8')
  await again.unmount()
})

test('a value an older build stored (no shape tag) reads as empty, not as a half-right stack', opts({}), async ($, on) => {
  const w = world(on)
  w.seed({ stack: [{ key: 'ZCC-8', state: 'ready', task: TASK, error: null }], layout: 'card' }) // 0.1.0's value
  await $.session.start(START)
  const ui = await mount($)
  expect(text(await ui.drawn())).toContain('nothing opened')
  await ui.unmount()
  await $.command.run(RUN('ZCC-8'))
  expect(names(w)).toEqual(['task:ZCC-8:ready'])
})

test('a minimized pane on the desktop app: one line, no buttons', opts({}), async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC'))
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'desktop', component: 'Pane', requestId: 'zinn-show', props: { ...(PANE_PROPS as object), placement: 'widget' } as never, viewport: VIEW })
  const t = text(await ui.drawn())
  expect(t).toContain('Zinn · ZCC board')
  expect(t).not.toContain('Button')
  await ui.unmount()
})

test('j goes back one entry, and closes when nothing is behind; q closes; there is no Esc', opts({}), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.command.run(RUN('ZCC-8'))
  const ui = await mount($)
  expect(text(await ui.drawn())).toContain('back (closes)')
  await ui.press({ key: 'open:ZCC-9' })
  expect(w.view()?.stack.map(x => x.key)).toEqual(['ZCC-8', 'ZCC-9'])
  await ui.unmount()
  const again = await mount($)
  expect(text(await again.drawn())).toContain('back to ZCC-8')
  await again.press({ key: 'nav:back' })
  expect(w.view()?.stack.map(x => x.key)).toEqual(['ZCC-8'])
  expect(w.closes).toEqual([])
  await again.press({ key: 'nav:back' })
  expect(w.closes).toEqual(['zinn-show'])
  await again.press({ key: 'nav:close' })
  expect(w.closes).toEqual(['zinn-show', 'zinn-show'])
  expect(w.opens.every(o => o.closeOnEscape === undefined)).toBe(true)
  await again.unmount()
})
