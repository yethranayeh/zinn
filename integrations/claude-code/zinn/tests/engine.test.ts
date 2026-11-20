// The transcript part loaded by the engine's own host, a stubbed world beneath it, on the terminal
// and desktop surfaces. `claude plugin test` stubs the engine and calls no model. `process.run` is stubbed,
// so no store is touched. The test's own `ui.render` hook stands for the engine's drawing: it records the
// props the mod passed on (the text looks are asserted on the text that reached it) and draws a plain
// Text. The colour and under looks are asserted on the tree (`find`/`findAll`).
//
// The kit exercises hooks, never a surface's paint. The colour test
// (colour.test.ts) paints the plans. Only a live run shows the terminal.
import { test, expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, PluginOptions, SessionEndReason } from 'claude-code'
import { claimJson, HOUR, ROWS } from './fixtures'
import { END_RESERVE_MS, heldColor } from '../lib/claims'
import type { KeyMapState } from '../lib/state'
import { VERSION } from '../hooks/client'

declare const console: { log: (...args: unknown[]) => void }

const SURFACES = ['terminal', 'desktop'] as const
const RUNNING = '2.1.296'
const SESSION = 'b7e1c0de-0000-4000-8000-000000000006'
const MAP_NAME = { plugin: 'zinn', key: 'map' } as const

type Zinn = { exitCode: number; stdout: string; stderr?: string; isStdoutTruncated?: boolean } | 'throw'
// 'hang': the release runs until its timeout on the mock clock, then rejects, as the engine's killed child does.
type Release = Zinn | 'hang'
type World = { drawn: string[]; summaries: (boolean | null)[]; runs: string[][]; status: string[]; toasts: string[]; registered: string[]; files: Map<string, string>; clock: ReturnType<typeof mock.clock>; zinn: Zinn[]; map: () => KeyMapState | undefined; modes: string[]; envs: { argv: string[]; env: Record<string, string> | undefined; timeoutMs: number | undefined }[]; logs: string[]; notified: string[]; surfaces: string[]; heartbeat: Record<string, Zinn>; release: Record<string, Release>; releaseHoldMs: number }

function world(on: On, o: { installed?: string; zinn?: Zinn | Zinn[]; env?: Record<string, string> } = {}): World {
  const queue = Array.isArray(o.zinn) ? [...o.zinn] : [o.zinn ?? { exitCode: 0, stdout: JSON.stringify(ROWS) }]
  const w: World = { drawn: [], summaries: [], runs: [], status: [], toasts: [], registered: [], files: new Map(), clock: undefined as never, zinn: queue, map: () => undefined, modes: [], envs: [], logs: [], notified: [], surfaces: ['terminal'], heartbeat: {}, release: {}, releaseHoldMs: 0 }
  w.clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 9, 0, 0) })
  mock.env(on, o.env ?? {})
  // The kit's Engine `$` has no `state` noun (tsc TS2339, runtime TypeError), but `state.get` and
  // `state.set` are events the mod's own `$.state` calls raise, and a test hook sits beneath the mod.
  // So the test is the state store: it keeps what the mod published under zinn.map and answers
  // the mod's own `$.state.get`. A test reads it through `w.map()`.
  let published: KeyMapState | undefined
  let version = 0
  w.map = () => published
  on('state.set', MAP_NAME, async (_$, e) => { published = e.value as KeyMapState; version += 1; return { value: { isSet: true as const, version } } })
  on('state.get', MAP_NAME, async () => ({ value: { value: published, version } }))
  on('session.version', async () => ({ value: { version: RUNNING, base: RUNNING } }))
  on('session.id', async () => ({ value: SESSION }))
  on('ui.status', async (_$, e) => { w.status.push(e.text === undefined ? '' : String(e.text)); return { value: undefined } }) // '' = the line was cleared
  on('ui.toast', async (_$, e) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('ui.log', async (_$, e) => { w.logs.push(String(e.text)); return { value: undefined } })
  on('ui.notify', async (_$, e) => { w.notified.push(String(e.text)); return { value: { isSent: true as const, channel: 'client' as const } } })
  on('session.surfaces', async () => ({ value: w.surfaces as never }))
  on('command.register', async (_$, e) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    w.envs.push({ argv, env: e.init?.env, timeoutMs: e.init?.timeoutMs })
    const res = (r: { exitCode: number; stdout: string; stderr?: string; isStdoutTruncated?: boolean }) => ({ value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', isStdoutTruncated: r.isStdoutTruncated ?? false, isStderrTruncated: false } })
    if (argv[0] === 'claude') {
      return res({ exitCode: 0, stdout: `${o.installed ?? RUNNING} (Claude Code)\n` })
    }
    if (argv[1] === 'activity') {
      return res({ exitCode: 0, stdout: '[]' })
    } // ZCC-7 poll baseline: live.test.ts covers it
    if (argv[0] === 'zinn' && argv[2] === 'heartbeat') {
      const h = w.heartbeat[argv[3]!] ?? { exitCode: 1, stdout: '', stderr: '{"error":{"code":"storage","message":"boom"}}' }
      if (h === 'throw') {
        throw new Error('spawn zinn ENOENT')
      }
      return res(h)
    }
    if (argv[0] === 'zinn' && argv[2] === 'release') {
      const key = argv[3]!
      const answer = w.release[key] ?? { exitCode: 0, stdout: JSON.stringify({ ...ROWS.find(r => r.key === key), claim: null, changed: true }) }
      if (w.releaseHoldMs > 0) {
        await w.clock.sleep(w.releaseHoldMs)
      }
      if (answer === 'hang') {
        await w.clock.sleep(e.init?.timeoutMs ?? 30_000)
        throw new Error('timed out')
      }
      if (answer === 'throw') {
        throw new Error('spawn zinn ENOENT')
      }
      return res(answer)
    }
    if (argv[0] === 'zinn') {
      const z = (w.zinn.length > 1 ? w.zinn.shift() : w.zinn[0])!
      if (z === 'throw') {
        throw new Error('spawn zinn ENOENT')
      }
      return res(z)
    }
    return res({ exitCode: 127, stdout: '', stderr: 'unknown' })
  })
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', async (_$, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.write', async (_$, e) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('ui.render', async (_$, e) => {
    if (e.component === 'SessionMode') { w.modes = [...(e.props as { modes: readonly string[] }).modes]; return { type: 'Text', props: {}, children: [''] } as never }
    const p = e.props as { text?: string; isSummary?: true }
    const t = String(p.text ?? '')
    w.drawn.push(t)
    w.summaries.push(e.component === 'AssistantMessage' ? p.isSummary === true : null)
    return { type: 'Text', props: {}, children: [t] } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false } as never, text: '' }))
  return w
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const VIEW = { columns: 120, rows: 40, isFullscreen: true } as const
const AM = (text: string, extra: { isSummary?: true } = {}) => ({ text, isFirstOfReply: true, ...(extra.isSummary ? { isSummary: true as const } : {}) })
const UM = (text: string, isExpanded = false) => ({ text, origin: { kind: 'composer' as const }, isExpanded })
const RUN = (args: string) => ({ command: 'zinn', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as const
const opts = (o: PluginOptions): { options: PluginOptions } => ({ options: o })
let rid = 0
const nextId = (tag: string): string => `${tag}-${++rid}`
const records = (w: World): Record<string, unknown>[] =>
  [...w.files.entries()].filter(([p]) => p.endsWith('.jsonl')).flatMap(([, t]) => t.split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>))
const ZINN = ['zinn', 'task', 'list', '--all', '--json']

test('session.start: two processes, both by argv; the map is published in $.state; /zinn registered; status', opts({ look: 'suffix' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.runs.filter(a => a[1] !== 'activity').sort()).toEqual([['claude', '--version'], ZINN])
  expect(w.registered).toEqual(['zinn-show', 'zinn'])
  const value = w.map()
  expect(value?.status).toBe('ready')
  expect(Object.keys(value?.keys ?? {}).length).toBe(ROWS.length)
  expect(value?.keys['ZCC-6']?.column).toBe('In Progress')
  expect(value?.argv).toEqual(ZINN)
  expect(value?.loadedAt).toBe('2026-10-12T09:00:00.000Z')
  expect(w.status).toEqual(['']) // nothing is pinned while all is well (0.2.0); `statusLine: always` is the old line
  expect(w.files.size).toBe(0) // the log is off by default
})

// ZCC-2: the inherited chain, then the plugin's token. Only ZINN_CLIENT is set over the host's environment.
const TOKEN = `zinn-claude-code:mentions/${VERSION}`
const CLIENT_CASES: [string, Record<string, string>, string][] = [
  ['no inherited chain', {}, TOKEN],
  ['an inherited chain', { ZINN_CLIENT: 'rex/0.9' }, `rex/0.9 ${TOKEN}`],
  ['a padded inherited chain', { ZINN_CLIENT: '  rex/0.9 other/1  ' }, `rex/0.9 other/1 ${TOKEN}`],
  ['a whitespace-only inherited chain', { ZINN_CLIENT: '  ' }, TOKEN],
]
for (const [name, env, chain] of CLIENT_CASES) {
  test(`ZCC-2 ZINN_CLIENT with ${name}: every zinn run declares the plugin, claude --version declares nothing`, opts({}), async ($, on) => {
    const w = world(on, { env })
    await $.session.start(START)
    const zinnRuns = w.envs.filter(r => r.argv[0] === 'zinn')
    expect(zinnRuns.map(r => r.argv[1]).sort()).toEqual(['activity', 'task'])
    expect(zinnRuns.map(r => r.env)).toEqual(zinnRuns.map(() => ({ ZINN_CLIENT: chain })))
    expect(w.envs.filter(r => r.argv[0] === 'claude').map(r => r.env)).toEqual([undefined])
  })
}

test('suffix: the text reaching the engine, on both surfaces; unknown key flagged; FOO-12 (no FOO board) not caught', opts({ look: 'suffix' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('sx'), props: AM('Next ZCC-8, then ZCC-99 and FOO-12.'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('Next ZCC-8 · ○ Task detail pane, then ZCC-99 · **✗ not in Zinn** and FOO-12.')
    await ui.unmount()
  }
})

test('brackets: the decoration has an end', opts({ look: 'brackets', marks: 'words' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('br'), props: AM('ZCC-7 is stuck.'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('ZCC-7 \\[blocked: Keep the key map live\\] is stuck.')
    await ui.unmount()
  }
})

test('no repeated title: the model wrote it after the key', opts({ look: 'suffix' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('echo'), props: AM('**ZCC-5**: Spike: does rewriting AssistantMessage text draw…'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('**ZCC-5** · ◑: Spike: does rewriting AssistantMessage text draw…')
})

test('colour: the mod\'s own tree keeps the formatting; key bold, mark coloured, title dim; the fence stays Markdown', opts({ look: 'colour' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const text = '**Plan:** ZCC-6 then `zinn task view ZCC-8`.\n\n- ZCC-7 waits\n\n```\nzinn task move ZCC-6 Done\n```'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('col'), props: AM(text), viewport: VIEW })
    if (surface === 'terminal') {
      console.log('colour tree:', JSON.stringify(await ui.drawn()).slice(0, 900))
    }
    expect((await ui.find({ type: 'Text', text: /^Plan:$/ }))?.props['bold']).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^ZCC-6$/ }))?.props['bold']).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^ZCC-6$/ }))?.props['color']).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^◐$/ }))?.props['color']).toBe('warning')
    expect((await ui.find({ type: 'Text', text: /^⊘$/ }))?.props['color']).toBe('error')
    expect((await ui.find({ type: 'Text', text: /^ Build key-lines MVP/ }))?.props['dimColor']).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^zinn task view ZCC-8$/ }))?.props['color']).toBe('permission')
    // No raw ** or backticks anywhere the mod drew
    expect((await ui.findAll({ type: 'Text', text: /\*\*|`/ })).filter(t => t.type === 'Text').length).toBe(0)
    const md = (await ui.findAll({ type: 'Markdown' })).map(m => m.text)
    expect(md).toEqual(['```\nzinn task move ZCC-6 Done\n```'])
    expect(w.drawn.length).toBe(0) // the engine's own drawing was not asked for
    await ui.unmount()
  }
})

test('colour: a table holding a key is left to the engine, decorated as text', opts({ look: 'colour', log: true }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('tbl'), props: AM('| key | note |\n|---|---|\n| ZCC-8 | next |'), viewport: VIEW })
  const md = (await ui.findAll({ type: 'Markdown' })).map(m => m.text)
  expect(md).toEqual(['| key | note |\n|---|---|\n| ZCC-8 · ○ Task detail pane | next |'])
  await w.clock.advance(2100)
  expect(records(w).filter(r => r['ev'] === 'render').at(-1)?.['fallbacks']).toBe(1)
})

test('under: the engine draws the text untouched; one line under it', opts({ look: 'under', legend: 'spaced', maxEntries: '0' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('un'), props: AM('ZCC-6 and ZCC-99, again ZCC-6.'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('ZCC-6 and ZCC-99, again ZCC-6.')
    const line = await ui.find({ type: 'Text', text: /^↳ / })
    expect(line?.text).toBe('↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…   ZCC-99 ✗ not in Zinn')
    expect((await ui.find({ type: 'Text', text: /^ZCC-99 ✗ not in Zinn$/ }))?.props['color']).toBe('error')
    await ui.unmount()
  }
})

// ---- the `under` look -----------------------------------------------------------------------------------
// The engine draws the message untouched (the test's ui.render hook records what reached it). The mod
// adds one dim `↳` line under it. The line is asserted on the tree. The line's first span is a nested Text
// that is just `↳ `. The pattern `^↳ \S` skips it and finds the outer line only (one hit per drawn line).
// A style whose first span merges `↳ ` with a following dim `[` makes a nested hit that is a prefix of the line: dropped.
const arrows = async (ui: { findAll: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string }[]> }): Promise<string[]> => {
  const all = (await ui.findAll({ type: 'Text', text: /^↳ \S/ })).map(n => String(n.text))
  // a one-span line (the dim `+N more`) is drawn as a Text inside a Text: both hit, so equal neighbours collapse
  return all.filter(t => !all.some(o => o !== t && o.startsWith(t))).filter((t, i, a) => i === 0 || t !== a[i - 1])
}

test('under, my own prompt: text untouched, one line under it; expanded passes untouched', opts({ look: 'under', legend: 'spaced', maxEntries: '0', myPrompts: 'decorate', log: true }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'UserMessage', requestId: nextId('umu'), props: UM('look at SAM-2'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('look at SAM-2') // the text is not rewritten, and a prompt is never held by the tail guard
    expect(await arrows(ui)).toEqual(['↳ SAM-2 ● Old task two'])
    await ui.redraw(UM('and SAM-27 or ZCC-42'))
    expect(w.drawn.at(-1)).toBe('and SAM-27 or ZCC-42')
    expect(await arrows(ui)).toEqual(['↳ SAM-27 ◐ Calibrate the `probe` | table *x* [y]   ZCC-42 ✗ not in Zinn']) // no backslashes: a prompt is printable text
    await ui.redraw(UM('and SAM-27', true))
    expect(w.drawn.at(-1)).toBe('and SAM-27')
    expect(await arrows(ui)).toEqual([]) // expanded: passes through untouched, no line
    await ui.unmount()
  }
  await w.clock.advance(2100)
  const um = records(w).filter(r => r['ev'] === 'render' && r['comp'] === 'UserMessage')
  expect(um.some(r => r['did'] === 'held')).toBe(false)
  expect(um.filter(r => r['why'] === 'expanded').every(r => r['calls'] === 0)).toBe(true)
})

test('under, my own prompt left as typed (ZINN_MENTIONS_MY_PROMPTS=leave): untouched, no line, no $ call', opts({ look: 'under', log: true }), async ($, on) => {
  const w = world(on, { env: { ZINN_MENTIONS_MY_PROMPTS: 'leave' } })
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'UserMessage', requestId: nextId('uml'), props: UM('do ZCC-8'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('do ZCC-8')
    expect(await arrows(ui)).toEqual([])
    await ui.unmount()
  }
  await w.clock.advance(2100)
  const r = records(w).filter(x => x['ev'] === 'render')
  expect(r.length).toBe(SURFACES.length)
  expect(r.every(x => x['did'] === 'pass' && x['why'] === 'own prompt left' && x['calls'] === 0)).toBe(true)
})

// ---- legend styles and the indent ------------------------------------------------------------------
// Each style on both surfaces, through the hook: the engine's drawing is untouched, the legend sits in a
// Box padded to the reply's text column. The unknown key keeps its error colour in every style.
const LEGEND_TEXT = 'Next ZCC-6 and ZCC-8, ZCC-99 is not on the board.'
const L6 = 'ZCC-6 ◐ Build key-lines MVP: key decorations in…'
const L8 = 'ZCC-8 ○ Task detail pane'
const L99 = 'ZCC-99 ✗ not in Zinn'
const LEGEND_LINES: Record<string, string[]> = {
  spaced: [`↳ ${L6}   ${L8}   ${L99}`],
  brackets: [`↳ [${L6}] [${L8}] [${L99}]`],
  dots: [`↳ ${L6} · ${L8} · ${L99}`],
  stacked: [`↳ ZCC-6  ${L6.slice(6)}`, `↳ ZCC-8  ${L8.slice(6)}`, `↳ ${L99}`], // padded to ZCC-99
}
for (const legend of ['spaced', 'brackets', 'dots', 'stacked'] as const) {
  test(`under, legend ${legend}: text untouched, the legend's lines, unknown in the error colour, indented`, opts({ look: 'under', legend, maxEntries: '0', keyPress: 'off' }), async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId(`lg-${legend}`), props: AM(LEGEND_TEXT), viewport: VIEW })
      await ui.drawn()
      expect(w.drawn.at(-1)).toBe(LEGEND_TEXT)
      expect(await arrows(ui)).toEqual(LEGEND_LINES[legend])
      expect((await ui.find({ type: 'Text', text: /^ZCC-99 ✗ not in Zinn$/ }))?.props['color']).toBe('error') // key and mark share one error-coloured span
      expect((await ui.findAll({ type: 'Box' })).filter(b => b.props['paddingLeft'] === 2).length).toBe(1) // the legend's Box
      await ui.unmount()
    }
  })
}

test('ZCC-6 under: a held task says whose and until when; the session id and the clock decide', opts({ look: 'under', maxEntries: '0', keyPress: 'off' }), async ($, on) => {
  const at = Date.UTC(2026, 9, 12, 9, 0, 0) // the world's clock
  const rows = ROWS.map(r => (r.key === 'ZCC-6' ? { ...r, claim: claimJson(SESSION, at + HOUR) } : r.key === 'ZCC-8' ? { ...r, claim: claimJson('another-session', at + HOUR) } : r.key === 'ZCC-7' ? { ...r, claim: claimJson('gone', at - 1) } : r))
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(rows) } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('claim'), props: AM('ZCC-6, ZCC-8 and ZCC-7'), viewport: VIEW })
  await ui.drawn()
  const lines = await arrows(ui)
  expect(lines[0]).toMatch(/^↳ ZCC-6 .* · yours until \d\d:\d\d$/)
  expect(lines[1]).toMatch(/^↳ ZCC-8 .* · held until \d\d:\d\d$/)
  expect(lines[2]).not.toContain('until') // its lease ran out: drawn as free
  expect((await ui.find({ type: 'Text', text: /^ · held until \d\d:\d\d$/ }))?.props['color']).toBe('warning')
  expect(w.drawn.at(-1)).toBe('ZCC-6, ZCC-8 and ZCC-7')
})

test('ZCC-6 under: a claim that runs out is redrawn as free, with no store read', opts({ look: 'under', maxEntries: '0', keyPress: 'off' }), async ($, on) => {
  const at = Date.UTC(2026, 9, 12, 9, 0, 0)
  const lease = 60_000
  const rows = ROWS.map(r => (r.key === 'ZCC-8' ? { ...r, claim: claimJson('another-session', at + lease) } : r))
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(rows) } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('expiry'), props: AM('ZCC-8 is next.'), viewport: VIEW })
  await ui.drawn()
  expect((await arrows(ui))[0]).toContain('held until')
  const runs = w.runs.length
  await w.clock.advance(lease + 1100)
  await ui.drawn()
  expect((await arrows(ui))[0]).not.toContain('until')
  expect(w.runs.slice(runs).filter(a => a[0] === 'zinn' && a[1] === 'task')).toEqual([])
})

test('under, legend from the variable (ZINN_MENTIONS_LEGEND=brackets); the option beats it', opts({ look: 'under', maxEntries: '0' }), async ($, on) => {
  const w = world(on, { env: { ZINN_MENTIONS_LEGEND: 'brackets' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('lgenv'), props: AM(LEGEND_TEXT), viewport: VIEW })
  await ui.drawn()
  expect(await arrows(ui)).toEqual(LEGEND_LINES['brackets'])
  expect(w.drawn.at(-1)).toBe(LEGEND_TEXT)
})

// The default is stacked with a cap of 5 and a dim "+N more" line.
const CAP_TEXT = 'Batch: ' + [1, 2, 3, 4, 5, 6, 7, 8].map(n => `MNY-${n}`).join(', ') + ' and ZCC-99.'
const capRows = () => ({ zinn: { exitCode: 0, stdout: JSON.stringify([...MANY_ROWS, ...ROWS]) } })
test('under, defaults: stacked, cap 5, unknown ZCC-99 named on the overflow row, not counted against the cap', opts({ look: 'under', keyPress: 'off' }), async ($, on) => {
  const w = world(on, capRows())
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('cap'), props: AM(CAP_TEXT), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe(CAP_TEXT)
    const lines = await arrows(ui)
    expect(lines.length).toBe(6) // 5 entries + overflow
    expect(lines.at(-1)).toBe('↳ +3 more | ZCC-99 ✗ not in Zinn')
    expect(lines.slice(0, -1).map(l => l.slice(0, 8))).toEqual(['↳ MNY-1 ', '↳ MNY-2 ', '↳ MNY-3 ', '↳ MNY-4 ', '↳ MNY-5 '])
    expect(lines.some(l => l.includes('ZCC-99 ✗ not in Zinn'))).toBe(true)
    expect((await ui.findAll({ type: 'Text', text: '+3 more' })).some(n => n.props['dimColor'] === true)).toBe(true) // the inner span is dim
    await ui.unmount()
  }
})

test('under, cap from the variable ZINN_MENTIONS_MAX_ENTRIES=0: no cap, no overflow line; the option beats it', opts({ look: 'under', keyPress: 'off' }), async ($, on) => {
  world(on, { ...capRows(), env: { ZINN_MENTIONS_MAX_ENTRIES: '0' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('cap0'), props: AM(CAP_TEXT), viewport: VIEW })
  await ui.drawn()
  const lines = await arrows(ui)
  expect(lines.length).toBe(9)
  expect(lines.some(l => l.includes('more'))).toBe(false)
})

test('under, cap option 2 beats the variable; spaced style is capped too', opts({ look: 'under', maxEntries: '2', legend: 'spaced' }), async ($, on) => {
  world(on, { ...capRows(), env: { ZINN_MENTIONS_MAX_ENTRIES: '0' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('cap2'), props: AM(CAP_TEXT), viewport: VIEW })
  await ui.drawn()
  const lines = await arrows(ui)
  expect(lines.length).toBe(2)
  expect(lines[1]).toBe('↳ +6 more | ZCC-99 ✗ not in Zinn')
  expect(lines[0]).not.toContain('ZCC-99')
})

test('under, indent: the legend is in a Box with paddingLeft 2 (the reply text column), so wrapped lines start there too', opts({ look: 'under' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('ind'), props: { ...AM('ZCC-6 is it.'), isFirstOfReply: false }, viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('ZCC-6 is it.')
    const pads = (await ui.findAll({ type: 'Box' })).filter(b => b.props['paddingLeft'] === 2) // ElementQuery has no props filter
    expect(pads.length).toBe(1)
    const pad = pads[0]!
    expect(pad.props['flexDirection']).toBe('column')
    expect(String(pad.text)).toBe('↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…') // holds the legend and nothing of the reply
    // a block that is not the first of its reply (isFirstOfReply false, as here) is indented the same
    await ui.unmount()
  }
})

// The UserMessage hook is registered only when the OPTION is not `leave`.
test('myPrompts option leave: the mod is not in the UserMessage drawing at all (no hook ran: no render record)', opts({ look: 'under', myPrompts: 'leave', log: true, keyPress: 'off' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const um = await $.ui.mount({ plugin: 'zinn', surface, component: 'UserMessage', requestId: nextId('umx'), props: UM('do ZCC-8'), viewport: VIEW })
    await um.drawn()
    expect(w.drawn.at(-1)).toBe('do ZCC-8')
    expect(await arrows(um)).toEqual([])
    const am = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('amx'), props: AM('Next ZCC-8.'), viewport: VIEW })
    await am.drawn()
    expect(await arrows(am)).toEqual(['↳ ZCC-8 ○ Task detail pane']) // control: replies still get the line
    await um.unmount()
    await am.unmount()
  }
  await w.clock.advance(2100)
  const r = records(w).filter(x => x['ev'] === 'render')
  expect(r.filter(x => x['comp'] === 'UserMessage').length).toBe(0)
  expect(r.filter(x => x['comp'] === 'AssistantMessage').length).toBe(SURFACES.length)
})

test('own prompts are left by default; ZINN_MENTIONS_MY_PROMPTS=decorate or the option turns the line on', opts({ keyPress: 'off' }), async ($, on) => {
  const w = world(on, { env: { ZINN_MENTIONS_MY_PROMPTS: 'decorate' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'UserMessage', requestId: nextId('umd'), props: UM('do ZCC-8'), viewport: VIEW })
  await ui.drawn()
  expect(await arrows(ui)).toEqual(['↳ ZCC-8 ○ Task detail pane'])
  expect(w.drawn.at(-1)).toBe('do ZCC-8')
})

test('own prompts, no option and no variable: left as typed, no line', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'UserMessage', requestId: nextId('umn'), props: UM('do ZCC-8'), viewport: VIEW })
  await ui.drawn()
  expect(await arrows(ui)).toEqual([])
  expect(w.drawn.at(-1)).toBe('do ZCC-8')
})

test('under, summary: isSummary reaches the engine unchanged, and the mod adds no summary mark of its own', opts({ look: 'under', legend: 'spaced', maxEntries: '0' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const plain = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('sumu0'), props: AM('Did ZCC-8, thanks.'), viewport: VIEW })
    await plain.drawn()
    expect(w.summaries.at(-1)).toBe(false) // control: a plain reply is not marked
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('sumu'), props: AM('Did ZCC-8, thanks.', { isSummary: true }), viewport: VIEW })
    await ui.drawn()
    expect(w.summaries.at(-1)).toBe(true) // the engine draws its own " · summary"
    expect(w.drawn.at(-1)).toBe('Did ZCC-8, thanks.')
    expect(await arrows(ui)).toEqual(['↳ ZCC-8 ○ Task detail pane'])
    expect((await ui.findAll({ type: 'Text', text: /summary/ })).length).toBe(0)
    await ui.unmount()
    await plain.unmount()
  }
})

// Fifteen distinct keys in one block (MNY-7 is mentioned twice) -> one line, each key once, in order of first mention.
// With titles of 39 to 40 characters (the cap) the line is 761 characters. The mod does not wrap or cut it.
const MANY_ROWS = Array.from({ length: 15 }, (_, i) => ({ key: `MNY-${i + 1}`, status: 'Active', column: ['TODO', 'In Progress', 'Review', 'Blocked', 'Done'][i % 5]!, title: `Intake ${i + 1}: reconcile the old board lanes` }))
const MANY_MARK = ['○', '◐', '◑', '⊘', '●']
const MANY_ORDER = [1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const MANY_LINE = '↳ ' + [...new Set(MANY_ORDER)].map(n => `MNY-${n} ${MANY_MARK[(n - 1) % 5]} Intake ${n}: reconcile the old board lanes`).join('   ')
test(`under, many keys: 15 distinct keys in one block -> exactly one line, in order of first mention, each once (${MANY_LINE.length} characters)`, opts({ look: 'under', legend: 'spaced', maxEntries: '0' }), async ($, on) => {
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(MANY_ROWS) } })
  await $.session.start(START)
  const text = 'Batch: ' + MANY_ORDER.map(n => `MNY-${n}`).join(', ') + ' and that is all.'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('many'), props: AM(text), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe(text)
    const lines = await arrows(ui)
    expect(lines.length).toBe(1)
    expect(lines[0]).toBe(MANY_LINE)
    expect(lines[0]!.length).toBe(761)
    expect(lines[0]!.split('MNY-7').length - 1).toBe(1)
    await ui.unmount()
  }
})

test('under, streaming growth: no key passes plain; one key adds the line; a second key adds its entry', opts({ look: 'under', legend: 'spaced', maxEntries: '0', tailGuardMs: 400 }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const rid = nextId('grow')
    const t1 = 'Looking at the board now'
    const t2 = 'Looking at the board now. ZCC-6 is the one, and then'
    const t3 = 'Looking at the board now. ZCC-6 is the one, and then ZCC-8 follows after it.'
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: rid, props: AM(t1), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe(t1)
    expect(await arrows(ui)).toEqual([]) // no key: pass-through, no line
    await w.clock.advance(100)
    await ui.redraw(AM(t2))
    expect(w.drawn.at(-1)).toBe(t2)
    expect(await arrows(ui)).toEqual(['↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…'])
    await w.clock.advance(100)
    await ui.redraw(AM(t3))
    expect(w.drawn.at(-1)).toBe(t3)
    expect(await arrows(ui)).toEqual(['↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…   ZCC-8 ○ Task detail pane'])
    await ui.unmount()
  }
})

test('under, tail guard: a key at the very end of a streaming reply is left out of the line while held, then appears', opts({ look: 'under', legend: 'spaced', maxEntries: '0', tailGuardMs: 400 }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('tailu'), props: AM('ZCC-6 first, then SAM-2'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('ZCC-6 first, then SAM-2') // the text is never rewritten under this look
    expect(await arrows(ui)).toEqual(['↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…']) // SAM-2 may become SAM-27: held, left out
    await w.clock.advance(200)
    await ui.redraw(AM('ZCC-6 first, then SAM-27'))
    expect(await arrows(ui)).toEqual(['↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…']) // changed text: held again
    await w.clock.advance(420)
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('ZCC-6 first, then SAM-27')
    expect(await arrows(ui)).toEqual(['↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…   SAM-27 ◐ Calibrate the `probe` | table *x* [y]'])
    await ui.unmount()
  }
})

test('under, the legend keeps the title even when the reply already carries it (leaving out a repeated title applies to the inline looks only)', opts({ look: 'under', legend: 'spaced', maxEntries: '0' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const text = '**ZCC-5**: Spike: does rewriting AssistantMessage text draw… and then ZCC-8 follows.'
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('echou'), props: AM(text), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe(text)
    expect(await arrows(ui)).toEqual(['↳ ZCC-5 ◑ Spike: does rewriting AssistantMessage/…   ZCC-8 ○ Task detail pane'])
    await ui.unmount()
  }
})

test('my own prompt: decorated at once (no tail guard), as printable text (no escapes); expanded passes', opts({ look: 'suffix', myPrompts: 'decorate', log: true }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'UserMessage', requestId: nextId('um'), props: UM('look at SAM-2'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('look at SAM-2 · ● Old task two') // a prompt does not stream: never held
    await ui.redraw(UM('and SAM-27 or ZCC-42'))
    expect(w.drawn.at(-1)).toBe('and SAM-27 · ◐ Calibrate the `probe` | table *x* [y] or ZCC-42 · ✗ not in Zinn')
    await ui.redraw(UM('and SAM-27', true))
    expect(w.drawn.at(-1)).toBe('and SAM-27')
    await ui.unmount()
  }
  await w.clock.advance(2100)
  const um = records(w).filter(r => r['ev'] === 'render' && r['comp'] === 'UserMessage')
  expect(um.some(r => r['did'] === 'held')).toBe(false)
  expect(um.filter(r => r['why'] === 'expanded').every(r => r['calls'] === 0)).toBe(true)
})

test('my own prompt left as typed (ZINN_MENTIONS_MY_PROMPTS=leave): untouched, no $ call', opts({ look: 'colour', log: true }), async ($, on) => {
  const w = world(on, { env: { ZINN_MENTIONS_MY_PROMPTS: 'leave' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'UserMessage', requestId: nextId('ml'), props: UM('do ZCC-8'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('do ZCC-8')
  await w.clock.advance(2100)
  const r = records(w).filter(x => x['ev'] === 'render').at(-1)!
  expect([r['did'], r['why'], r['calls']]).toEqual(['pass', 'own prompt left', 0])
})

test('tail guard on replies: SAM-2 at the end is held, then decorated when the text stood still', opts({ look: 'suffix', tailGuardMs: 400 }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId('tail'), props: AM('Working on SAM-2'), viewport: VIEW })
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('Working on SAM-2')
    await w.clock.advance(200)
    await ui.redraw(AM('Working on SAM-27'))
    expect(w.drawn.at(-1)).toBe('Working on SAM-27')
    await w.clock.advance(420)
    await ui.drawn()
    expect(w.drawn.at(-1)).toBe('Working on SAM-27 · ◐ Calibrate the \\`probe\\` \\| table \\*x\\* \\[y\\]')
    await ui.unmount()
  }
})

test('keys in code are skipped', opts({ look: 'suffix' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const text = 'Run `zinn task view ZCC-8` then:\n```\nzinn task move ZCC-6 Done\n```\nok'
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('code'), props: AM(text), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe(text)
})

test('projects option: only ZCC is decorated or flagged', opts({ look: 'suffix', projects: 'ZCC' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('proj'), props: AM('SAM-27, SAM-99 and ZCC-8.'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('SAM-27, SAM-99 and ZCC-8 · ○ Task detail pane.')
})

test('summary: a text look keeps isSummary for the engine; the colour look writes the words itself', async ($, on) => {
  const w = world(on, { env: { ZINN_MENTIONS_LOOK: 'suffix' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('sum'), props: AM('Did ZCC-8.', { isSummary: true }), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('Did ZCC-8 · ○ Task detail pane.')
  expect(w.summaries.at(-1)).toBe(true)
  expect(w.status.at(-1)).toBe('')
})

// The footer label and the pinned line.
// `core` stands in for the engine's drawing of SessionMode and keeps the labels it was handed.
const footer = async ($: Parameters<TestBody>[0], w: World, modes: string[] = ['focus']): Promise<string[]> => {
  await $.ui.render({ surface: 'terminal', component: 'SessionMode', requestId: 'footer', props: { modes } })
  return w.modes
}

test('all well: no pinned line, one dim `zinn` among the footer labels; /zinn alone says the rest in a toast', opts({ look: 'under' }), async ($, on) => {
  const w = world(on)
  expect(await footer($, w)).toEqual(['focus']) // before session.start: nothing added
  await $.session.start(START)
  expect(w.status).toEqual([''])
  expect(await footer($, w)).toEqual(['focus', 'zinn'])
  expect(await footer($, w, ['focus', 'zinn'])).toEqual(['focus', 'zinn']) // a label already there: one, not two
  expect(await footer($, w, ['zinn ✗'])).toEqual(['zinn ✗'])
  for (const args of ['', 'status']) {
    const r = await $.command.run(RUN(args))
    expect(r.text).toBe(undefined) // nothing for the model to read
    expect(w.toasts.at(-1)).toBe(`zinn under · ${ROWS.length} keys`)
  }
})

test('a fault: the line is pinned and the label says so; a refresh that works clears both', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, { zinn: [{ exitCode: 1, stdout: '', stderr: '{"error":{"message":"database is locked"}}' }, { exitCode: 0, stdout: JSON.stringify(ROWS) }] })
  await $.session.start(START)
  expect(w.status.at(-1)).toBe('zinn under · no decorations (exit 1: database is locked)')
  expect(await footer($, w)).toEqual(['focus', 'zinn ✗'])
  await $.command.run(RUN('refresh'))
  expect(w.status.at(-1)).toBe('')
  expect(await footer($, w)).toEqual(['focus', 'zinn'])
})

test('statusLine always: the line of 0.1.0; statusLine off: never a line, the label alone carries a fault', opts({ look: 'suffix', statusLine: 'always' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.status.at(-1)).toBe(`zinn suffix · ${ROWS.length} keys`)
})

test('statusLine off, from the variable: no line even with a fault', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, { zinn: { exitCode: 1, stdout: '', stderr: 'boom' }, env: { ZINN_MENTIONS_STATUS_LINE: 'off' } })
  await $.session.start(START)
  expect(w.status.filter(t => t !== '')).toEqual([])
  expect(await footer($, w)).toEqual(['focus', 'zinn ✗'])
})

test('footerLabel false: no label; enabled false: no label either', opts({ look: 'under', footerLabel: false }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(await footer($, w)).toEqual(['focus'])
})

// What the mod draws after the engine's labels: each Text's string and colour, the core's empty Text left out.
const footerClaim = async ($: Parameters<TestBody>[0]): Promise<{ s: string; color: unknown }[]> => {
  const out: { s: string; color: unknown }[] = []
  const walk = (n: unknown): void => {
    if (typeof n !== 'object' || n === null) { return }
    const el = n as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
    const kids = el.children ?? (el.props?.['children'] as unknown[] | undefined) ?? []
    const list = Array.isArray(kids) ? kids : [kids]
    const text = list.filter(k => typeof k === 'string').join('')
    if (text !== '') { out.push({ s: text, color: el.props?.['color'] ?? (el.props?.['dimColor'] === true ? 'dim' : undefined) }) }
    list.forEach(walk)
  }
  walk(await $.ui.render({ surface: 'terminal', component: 'SessionMode', requestId: 'footer', props: { modes: ['focus'] } }))
  return out
}

test('ZCC-7 footer: the label names the task this session holds, the latest claim first, never another session', opts({ look: 'under' }), async ($, on) => {
  const at = Date.UTC(2026, 9, 12, 9, 0, 0) // the world's clock
  const rows = ROWS.map(r => (r.key === 'ZCC-6' ? { ...r, claim: claimJson(SESSION, at + HOUR) } : r.key === 'ZCC-7' ? { ...r, claim: claimJson(SESSION, at + 2 * HOUR) } : r.key === 'ZCC-8' ? { ...r, claim: claimJson('another-session', at + 3 * HOUR) } : r))
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(rows) } })
  await $.session.start(START)
  expect(await footer($, w)).toEqual(['focus', 'zinn']) // the engine's labels are unchanged
  expect(await footerClaim($)).toEqual([{ s: ' ◆ ZCC-7', color: heldColor('ZCC-7') }, { s: ' +1', color: 'dim' }])
})

test('ZCC-7 footer: a lease that runs out leaves the label, with no store read', opts({ look: 'under' }), async ($, on) => {
  const at = Date.UTC(2026, 9, 12, 9, 0, 0)
  const lease = 60_000
  const rows = ROWS.map(r => (r.key === 'ZCC-6' ? { ...r, claim: claimJson(SESSION, at + lease) } : r))
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(rows) } })
  await $.session.start(START)
  expect(await footerClaim($)).toEqual([{ s: ' ◆ ZCC-6', color: heldColor('ZCC-6') }])
  const runs = w.runs.length
  await w.clock.advance(lease + 1100)
  expect(await footerClaim($)).toEqual([])
  expect(w.runs.slice(runs).filter(a => a[0] === 'zinn' && a[1] === 'task')).toEqual([]) // the activity poll may tick
})

test('ZCC-7 footerClaim false: the label stays `zinn` while this session holds a task', opts({ look: 'under', footerClaim: false }), async ($, on) => {
  const at = Date.UTC(2026, 9, 12, 9, 0, 0)
  const rows = ROWS.map(r => (r.key === 'ZCC-6' ? { ...r, claim: claimJson(SESSION, at + HOUR) } : r))
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(rows) } })
  await $.session.start(START)
  expect(await footer($, w)).toEqual(['focus', 'zinn'])
  expect(await footerClaim($)).toEqual([])
})

// ZCC-24: notices about this session's own claims. The world's clock stands still until a test advances it.
const WORLD_NOW = Date.UTC(2026, 9, 12, 9, 0, 0)
const MINUTE = 60_000
const hm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const claimedRows = (claim: object | null) => ({ exitCode: 0, stdout: JSON.stringify(ROWS.map(r => (r.key === 'ZCC-6' ? { ...r, claim } : r))) })
const SESSION_END = { reason: 'other', sessionId: SESSION, resume: { id: SESSION } } as const
const taskReads = (w: World, from: number): string[][] => w.runs.slice(from).filter(a => a[0] === 'zinn' && a[1] === 'task')

test('ZCC-24 notices: a toast before this session\'s claim runs out, one when it has, each once, with no store read', opts({ look: 'under' }), async ($, on) => {
  const lease = 30 * MINUTE
  const expiresAt = WORLD_NOW + lease
  const w = world(on, { zinn: claimedRows(claimJson(SESSION, expiresAt, 'live', lease)) })
  await $.session.start(START)
  const runs = w.runs.length
  await w.clock.advance(lease - 3 * MINUTE - 1000) // a tenth of the lease is 3 minutes
  expect(w.toasts).toEqual([])
  await w.clock.advance(2000)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('ZCC-6')
  expect(w.toasts[0]).toContain(hm(expiresAt))
  expect(w.toasts[0]).toContain('expires')
  await w.clock.advance(3 * MINUTE)
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[1]).toContain('expired')
  expect(w.toasts[1]).toContain('ZCC-6')
  await w.clock.advance(HOUR)
  expect(w.toasts).toHaveLength(2)
  expect(taskReads(w, runs)).toEqual([])
  expect(w.notified).toEqual([]) // a terminal draws the toast
})

test('ZCC-24 notices: a lease of 50 minutes or more is warned 5 minutes ahead', opts({ look: 'under' }), async ($, on) => {
  const expiresAt = WORLD_NOW + 2 * HOUR
  const w = world(on, { zinn: claimedRows(claimJson(SESSION, expiresAt)) })
  await $.session.start(START)
  await w.clock.advance(2 * HOUR - 5 * MINUTE - 1000)
  expect(w.toasts).toEqual([])
  await w.clock.advance(2000)
  expect(w.toasts).toHaveLength(1)
})

test('ZCC-24 notices: another session\'s claim and a claim nobody holds give nothing', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, { zinn: claimedRows(claimJson('another-session', WORLD_NOW + 10 * MINUTE, 'live', 30 * MINUTE)) })
  await $.session.start(START)
  await w.clock.advance(HOUR)
  expect(w.toasts).toEqual([])
  await $.session.end(SESSION_END)
  expect(w.logs).toEqual([])
})

test('ZCC-24 notices: a claim that ran out before the session began is no news', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, { zinn: claimedRows(claimJson(SESSION, WORLD_NOW - MINUTE, 'expired')) })
  await $.session.start(START)
  await w.clock.advance(HOUR)
  expect(w.toasts).toEqual([])
})

test('ZCC-24 notices: a renewed claim is warned about at its new expiry, not the old one', opts({ look: 'under' }), async ($, on) => {
  const lease = 30 * MINUTE
  const first = WORLD_NOW + lease
  const w = world(on, { zinn: [claimedRows(claimJson(SESSION, first, 'live', lease)), claimedRows(claimJson(SESSION, first + 20 * MINUTE, 'live', lease))] })
  await $.session.start(START)
  await w.clock.advance(10 * MINUTE)
  await $.command.run(RUN('refresh')) // the heartbeat moved the expiry; the reload reads it
  w.toasts.length = 0
  await w.clock.advance(20 * MINUTE) // the old warning moment (27 minutes in) passes
  expect(w.toasts).toEqual([])
  await w.clock.advance(20 * MINUTE) // 47 minutes in is the new warning moment
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain(hm(first + 20 * MINUTE))
})

test('ZCC-24 notices: a claim released before its warning gives nothing', opts({ look: 'under' }), async ($, on) => {
  const lease = 30 * MINUTE
  const w = world(on, { zinn: [claimedRows(claimJson(SESSION, WORLD_NOW + lease, 'live', lease)), claimedRows(null)] })
  await $.session.start(START)
  await $.command.run(RUN('refresh'))
  w.toasts.length = 0
  await w.clock.advance(HOUR)
  expect(w.toasts).toEqual([])
})

test('ZCC-24 notices: a session with no screen raises the warning as a native notification too', opts({ look: 'under' }), async ($, on) => {
  const lease = 30 * MINUTE
  const w = world(on, { zinn: claimedRows(claimJson(SESSION, WORLD_NOW + lease, 'live', lease)) })
  w.surfaces = []
  await $.session.start(START)
  await w.clock.advance(lease - MINUTE)
  expect(w.notified).toHaveLength(1)
  expect(w.notified[0]).toContain('ZCC-6')
  expect(w.toasts).toEqual([w.notified[0]!])
})

test('ZCC-24 session end: names the claims this session still holds, never another session\'s', opts({ look: 'under' }), async ($, on) => {
  const rows = ROWS.map(r => (r.key === 'ZCC-6' ? { ...r, claim: claimJson(SESSION, WORLD_NOW + HOUR) } : r.key === 'ZCC-7' ? { ...r, claim: claimJson(SESSION, WORLD_NOW + 2 * HOUR) } : r.key === 'ZCC-8' ? { ...r, claim: claimJson('another-session', WORLD_NOW + HOUR) } : r))
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(rows) } })
  await $.session.start(START)
  await $.session.end(SESSION_END)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toContain('ZCC-6')
  expect(w.logs[0]).toContain('ZCC-7')
  expect(w.logs[0]).not.toContain('ZCC-8')
  expect(w.logs[0]).toContain(hm(WORLD_NOW + HOUR))
})

test('ZCC-24 session end: a claim that ran out is not held, so nothing is named', opts({ look: 'under' }), async ($, on) => {
  const lease = 30 * MINUTE
  const w = world(on, { zinn: claimedRows(claimJson(SESSION, WORLD_NOW + lease, 'live', lease)) })
  await $.session.start(START)
  await w.clock.advance(lease + 1000)
  await $.session.end(SESSION_END)
  expect(w.logs).toEqual([])
})

test('ZCC-24 claimNotices false: no toast, no notification and no notice at the end', opts({ look: 'under', claimNotices: false }), async ($, on) => {
  const lease = 30 * MINUTE
  const w = world(on, { zinn: claimedRows(claimJson(SESSION, WORLD_NOW + lease, 'live', lease)) })
  w.surfaces = []
  await $.session.start(START)
  await w.clock.advance(lease - MINUTE)
  await $.session.end(SESSION_END)
  expect(w.toasts).toEqual([])
  expect(w.notified).toEqual([])
  expect(w.logs).toEqual([])
})

// ZCC-25: a main-loop turn that ran a tool renews this session's claims with less than half the lease left.
const LEASE = 30 * MINUTE
const heartbeats = (w: World): string[][] => w.runs.filter(a => a[0] === 'zinn' && a[2] === 'heartbeat')
const renewedRow = (expiresAt: number) => ({ exitCode: 0, stdout: JSON.stringify({ ...ROWS.find(r => r.key === 'ZCC-6')!, claim: claimJson(SESSION, expiresAt, 'live', LEASE), changed: true }) })
const refusal = (reason: string) => ({ exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'conflict', message: 'refused', details: { entity: 'task', key: 'ZCC-6', reason } } }) })
let turnSeq = 0
async function turn($: Parameters<TestBody>[0], w: World, o: { tool?: boolean; agentId?: string } = {}): Promise<void> {
  const turnId = `t-${++turnSeq}`
  const loop = o.agentId === undefined ? {} : { agentId: o.agentId }
  await $.turn.start({ text: 'go', turnId, ...loop })
  if (o.tool !== false) {
    await $.tool.call({ tool: 'Read', file_path: '/tmp/x', ...loop } as never)
  }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...loop })
  for (let i = 0; i < 5; i++) await w.clock.advance(10)
}
const held30 = () => ({ zinn: claimedRows(claimJson(SESSION, WORLD_NOW + LEASE, 'live', LEASE)) })

test('ZCC-25 renewal: a tool turn under half the lease renews once, with the session and the client token', opts({ look: 'under', keyPress: 'off' }), async ($, on) => {
  const w = world(on, held30())
  await $.session.start(START)
  await w.clock.advance(16 * MINUTE)
  const renewedUntil = WORLD_NOW + 16 * MINUTE + LEASE
  w.heartbeat['ZCC-6'] = renewedRow(renewedUntil)
  await turn($, w)
  expect(heartbeats(w)).toEqual([['zinn', 'task', 'heartbeat', 'ZCC-6', '--json']])
  const env = w.envs.find(x => x.argv[2] === 'heartbeat')!.env!
  expect(env['ZINN_SESSION_ID']).toBe(SESSION)
  expect(env['ZINN_CLIENT']).toBe(`zinn-claude-code:claims/${VERSION}`)
  // The answer moved the expiry: the legend, and the notice timer, follow it with no read.
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('renew'), props: AM('ZCC-6 now'), viewport: VIEW })
  await ui.drawn()
  expect((await arrows(ui))[0]).toContain(hm(renewedUntil))
  await w.clock.advance(14 * MINUTE) // past the old warning moment, 27 minutes in
  expect(w.toasts).toEqual([])
  await turn($, w) // more than half the new lease left: nothing
  expect(heartbeats(w)).toHaveLength(1)
  await w.clock.advance(12 * MINUTE)
  expect(w.toasts).toEqual([])
  await w.clock.advance(MINUTE) // 43 minutes in is the new warning moment
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain(hm(renewedUntil))
})

test('ZCC-25 renewal: nothing with more than half the lease left, after a turn without tools, or after a subagent\'s turn', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, held30())
  w.heartbeat['ZCC-6'] = renewedRow(WORLD_NOW + HOUR)
  await $.session.start(START)
  await w.clock.advance(10 * MINUTE)
  await turn($, w)
  expect(heartbeats(w)).toEqual([])
  await w.clock.advance(6 * MINUTE)
  await turn($, w, { tool: false })
  await turn($, w, { agentId: 'sub-1' })
  expect(heartbeats(w)).toEqual([])
  await turn($, w) // control: the main loop's next tool turn renews
  expect(heartbeats(w)).toHaveLength(1)
})

test('ZCC-25 renewal: a claim that ran out is never renewed, and its notice shows', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, held30())
  w.heartbeat['ZCC-6'] = renewedRow(WORLD_NOW + HOUR)
  await $.session.start(START)
  await w.clock.advance(LEASE + MINUTE)
  await turn($, w)
  expect(heartbeats(w)).toEqual([])
  expect(w.toasts.some(t => t.includes('ZCC-6') && t.includes('expired'))).toBe(true)
})

test('ZCC-25 renewClaims false: no heartbeat', opts({ look: 'under', renewClaims: false }), async ($, on) => {
  const w = world(on, held30())
  w.heartbeat['ZCC-6'] = renewedRow(WORLD_NOW + HOUR)
  await $.session.start(START)
  await w.clock.advance(16 * MINUTE)
  await turn($, w)
  expect(heartbeats(w)).toEqual([])
})

for (const reason of ['claimed', 'claim_limit', 'not_claimed']) {
  test(`ZCC-25 renewal refused (${reason}): one toast, and the key is not renewed again`, opts({ look: 'under' }), async ($, on) => {
    const w = world(on, held30())
    w.heartbeat['ZCC-6'] = refusal(reason)
    await $.session.start(START)
    await w.clock.advance(16 * MINUTE)
    await turn($, w)
    expect(heartbeats(w)).toHaveLength(1)
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('ZCC-6')
    await w.clock.advance(MINUTE)
    await turn($, w)
    expect(heartbeats(w)).toHaveLength(1)
    expect(w.toasts).toHaveLength(1)
  })
}

test('ZCC-25 renewal: zinn that does not run gives no toast', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, held30())
  w.heartbeat['ZCC-6'] = 'throw'
  await $.session.start(START)
  await w.clock.advance(16 * MINUTE)
  await turn($, w)
  await w.clock.advance(MINUTE)
  await turn($, w)
  expect(heartbeats(w).length).toBeGreaterThan(0)
  expect(w.toasts).toEqual([])
})

// ZCC-26: a session that is done releases the claims it holds, when asked. The world's clock stands still until a test moves it.
const releases = (w: World): string[][] => w.runs.filter(a => a[0] === 'zinn' && a[2] === 'release')
const releaseKeys = (w: World): string[] => releases(w).map(a => a[3]!).sort()
/** The store as it reads when these keys are held by this session and those by another one. */
const holding = (mine: string[], theirs: string[] = []) => ({
  zinn: {
    exitCode: 0,
    stdout: JSON.stringify(ROWS.map(r => (mine.includes(r.key) ? { ...r, claim: claimJson(SESSION, WORLD_NOW + HOUR) } : theirs.includes(r.key) ? { ...r, claim: claimJson('another-session', WORLD_NOW + HOUR) } : r))),
  },
})
const endFor = (reason: SessionEndReason) => ({ reason, sessionId: SESSION, resume: { id: SESSION } }) as const
// Typed by the engine's reasons, so a reason it adds fails the type check until this says what it does.
const RELEASES_AT_END: Record<SessionEndReason, boolean> = { prompt_input_exit: true, logout: true, other: true, clear: true, resume: true }

for (const reason of Object.keys(RELEASES_AT_END) as SessionEndReason[]) {
  for (const isOn of [true, false]) {
    test(`ZCC-26 session end (${reason}) with releaseClaims ${isOn}: ${isOn && RELEASES_AT_END[reason] ? 'releases what this session holds, as this session' : 'writes nothing and names the claims still held'}`, opts({ look: 'under', releaseClaims: isOn }), async ($, on) => {
      const w = world(on, holding(['ZCC-6', 'ZCC-7'], ['ZCC-8']))
      await $.session.start(START)
      await $.session.end(endFor(reason))
      if (isOn && RELEASES_AT_END[reason]) {
        expect(releaseKeys(w)).toEqual(['ZCC-6', 'ZCC-7'])
        const env = w.envs.find(x => x.argv[2] === 'release')!.env!
        expect(env['ZINN_SESSION_ID']).toBe(SESSION)
        expect(env['ZINN_CLIENT']).toBe(`zinn-claude-code:claims/${VERSION}`)
        expect(w.logs).toEqual([]) // nothing is still held
        return
      }
      expect(releases(w)).toEqual([])
      expect(w.logs).toHaveLength(1)
      expect(w.logs[0]).toContain('ZCC-6')
      expect(w.logs[0]).toContain('ZCC-7')
      expect(w.logs[0]).not.toContain('ZCC-8')
    })
  }
}

test('ZCC-26 releaseClaims is off unless asked', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, holding(['ZCC-6']))
  await $.session.start(START)
  await $.session.end(SESSION_END)
  expect(releases(w)).toEqual([])
  expect(w.logs).toHaveLength(1)
})

test('ZCC-26 session end: every held claim is released at once, never another session\'s', opts({ look: 'under', releaseClaims: true }), async ($, on) => {
  const w = world(on, holding(['ZCC-6', 'ZCC-7', 'ZCC-5'], ['ZCC-8']))
  w.releaseHoldMs = 100
  await $.session.start(START)
  let isEnded = false
  const ending = $.session.end(SESSION_END).then(() => { isEnded = true })
  await w.clock.settle()
  expect(releaseKeys(w)).toEqual(['ZCC-5', 'ZCC-6', 'ZCC-7']) // all started before the first answered
  expect(isEnded).toBe(false)
  await w.clock.advance(100)
  await ending
  expect(releaseKeys(w)).toEqual(['ZCC-5', 'ZCC-6', 'ZCC-7'])
  expect(w.logs).toEqual([])
})

test('ZCC-26 session end: a release the time limit cuts off is left to the lease, and the others and the log still finish', opts({ look: 'under', releaseClaims: true, log: true }), async ($, on) => {
  const w = world(on, holding(['ZCC-6', 'ZCC-7']))
  w.release['ZCC-7'] = 'hang'
  await $.session.start(START)
  const ending = $.session.end(SESSION_END)
  await w.clock.settle()
  const cut = w.envs.find(x => x.argv[2] === 'release' && x.argv[3] === 'ZCC-7')!.timeoutMs!
  expect(cut).toBeGreaterThan(0) // a release is bounded by what the limit leaves, minus the reserve
  expect(cut).toBeLessThanOrEqual(10_000 - END_RESERVE_MS) // the kit's hook budget is 10 s
  await w.clock.advance(cut)
  await ending
  expect(releaseKeys(w)).toEqual(['ZCC-6', 'ZCC-7']) // no second try
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toContain('ZCC-7')
  expect(w.logs[0]).not.toContain('ZCC-6')
  const lines = records(w)
  expect(lines.filter(r => r['ev'] === 'release').map(r => [r['key'], r['result']]).sort()).toEqual([['ZCC-6', 'released'], ['ZCC-7', 'failed']])
  expect(lines.some(r => r['ev'] === 'end')).toBe(true)
})

test('ZCC-26 session end: a claim that already ran out is not released', opts({ look: 'under', releaseClaims: true }), async ($, on) => {
  const lease = 30 * MINUTE
  const claims: Record<string, object> = {
    'ZCC-6': claimJson(SESSION, WORLD_NOW - MINUTE, 'expired'),
    'ZCC-7': claimJson(SESSION, WORLD_NOW + lease, 'live', lease),
    'ZCC-5': claimJson(SESSION, WORLD_NOW + 2 * HOUR),
  }
  const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(ROWS.map(r => (r.key in claims ? { ...r, claim: claims[r.key] } : r))) } })
  await $.session.start(START)
  await w.clock.advance(lease + MINUTE) // ZCC-7 runs out while the session works
  await $.session.end(SESSION_END)
  expect(releaseKeys(w)).toEqual(['ZCC-5'])
  expect(w.logs).toEqual([])
})

test('ZCC-26 session end: a refusal means the claim is no longer this session\'s, a run that gives no answer leaves it named', opts({ look: 'under', releaseClaims: true }), async ($, on) => {
  const w = world(on, holding(['ZCC-6', 'ZCC-7', 'ZCC-5']))
  w.release['ZCC-6'] = refusal('claimed')
  w.release['ZCC-7'] = 'throw'
  await $.session.start(START)
  await $.session.end(SESSION_END)
  expect(releaseKeys(w)).toEqual(['ZCC-5', 'ZCC-6', 'ZCC-7'])
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toContain('ZCC-7')
  expect(w.logs[0]).not.toContain('ZCC-6')
  expect(w.logs[0]).not.toContain('ZCC-5')
})

test('ZCC-26 releaseClaims does not need the notices, and enabled false stops it', opts({ look: 'under', releaseClaims: true, claimNotices: false }), async ($, on) => {
  const w = world(on, holding(['ZCC-6']))
  w.release['ZCC-6'] = 'throw'
  await $.session.start(START)
  await $.session.end(SESSION_END)
  expect(releaseKeys(w)).toEqual(['ZCC-6'])
  expect(w.logs).toEqual([]) // still held, but the notices are off
})

test('ZCC-26 enabled false: no release', opts({ look: 'under', releaseClaims: true, enabled: false }), async ($, on) => {
  const w = world(on, holding(['ZCC-6']))
  await $.session.start(START)
  await $.session.end(SESSION_END)
  expect(releases(w)).toEqual([])
})

test('enabled false: nothing in the footer', opts({ enabled: false }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(await footer($, w)).toEqual(['focus'])
})

test('summary under colour: the own tree carries " · summary" after its last line', opts({ look: 'colour' }), async ($, on) => {
  world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('sumc'), props: AM('Did ZCC-8.', { isSummary: true }), viewport: VIEW })
  // `find({ text })` matches a Text by the text of its whole subtree (the 2.1.326 kit), so it answers
  // with the outer line. The mark is the Text whose own text is exactly the words.
  await ui.drawn()
  const mark = (await ui.findAll({ type: 'Text' })).find(x => x.text === ' · summary')
  expect(mark?.props['dimColor']).toBe(true)
})

test('/zinn refresh: reloads the map by argv, answers with no text, a toast says so, and the new key draws', opts({ look: 'suffix' }), async ($, on) => {
  const without8 = ROWS.filter(r => r.key !== 'ZCC-8')
  const w = world(on, { zinn: [{ exitCode: 0, stdout: JSON.stringify(without8) }, { exitCode: 0, stdout: JSON.stringify(ROWS) }] })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('ref'), props: AM('Next ZCC-8.'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('Next ZCC-8 · **✗ not in Zinn**.') // not in the store yet
  const r = await $.command.run(RUN('refresh'))
  expect(r.text).toBe(undefined) // nothing for the model to read
  expect(r.context).toBe(undefined)
  expect(w.toasts.at(-1)).toBe(`zinn: key map reloaded, ${ROWS.length} keys`)
  expect(w.runs.filter(x => x[0] === 'zinn' && x[1] !== 'activity')).toEqual([ZINN, ZINN])
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('Next ZCC-8 · ○ Task detail pane.')
  const other = await $.command.run(RUN('task ZCC-8')) // no other subcommand: the panel is its own mod
  expect(other.text).toBe(undefined)
  expect(w.toasts.at(-1)).toBe('zinn: usage /zinn [status | refresh]')
})

const FAILS: [string, Zinn, string][] = [
  ['exit 1 with a JSON error on stderr', { exitCode: 1, stdout: '', stderr: '{"error":{"message":"database is locked"}}' }, 'no decorations (exit 1: database is locked)'],
  ['truncated stdout', { exitCode: 0, stdout: JSON.stringify(ROWS).slice(0, 40), isStdoutTruncated: true }, 'no decorations (output over 4 MiB)'],
  ['bad JSON', { exitCode: 0, stdout: '[{"key":"SAM-1"' }, 'no decorations (bad JSON'],
  ['an error object on stdout', { exitCode: 0, stdout: '{"error":{"message":"x"}}' }, 'no decorations (bad JSON: expected a JSON array'],
  // A test hook that throws is skipped by the kit, so $.process.run rejects with the kit's own
  // "no implementation" error: the mod's rejection branch (zinn not on PATH), not a real ENOENT.
  ['process.run rejects', 'throw', 'no decorations (zinn did not run: '],
]
for (const [name, zinn, why] of FAILS) {
  test(`zinn failing (${name}): nothing decorated, one status line says why, $.state says failed`, opts({ look: 'colour', log: true }), async ($, on) => {
    const w = world(on, { zinn })
    await $.session.start(START)
    expect(w.status.at(-1)).toContain(why)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'zinn', surface, component: 'AssistantMessage', requestId: nextId(`fail-${name}`), props: AM('ZCC-8 here'), viewport: VIEW })
      await ui.drawn()
      expect(w.drawn.at(-1)).toBe('ZCC-8 here')
      await ui.unmount()
    }
    expect(w.map()?.status).toBe('failed')
    await w.clock.advance(2100)
    const renders = records(w).filter(r => r['ev'] === 'render')
    expect(renders.every(r => r['why'] === 'no map' && r['calls'] === 0)).toBe(true)
  })
}

test('version mismatch (running 2.1.296, installed 2.1.297): nothing drawn, status RESTART NEEDED', opts({ look: 'colour' }), async ($, on) => {
  const w = world(on, { installed: '2.1.297' })
  await $.session.start(START)
  expect(w.status.at(-1)).toBe('RESTART NEEDED (running 2.1.296, installed 2.1.297): zinn draws nothing until then')
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('ver'), props: AM('ZCC-8 here'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('ZCC-8 here')
})

test('enabled = false: the store is never read, nothing is drawn', opts({ enabled: false, look: 'suffix' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.runs.filter(x => x[0] === 'zinn')).toEqual([])
  expect(w.status.at(-1)).toBe('') // off is the person's choice, not a fault: no line
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('dis'), props: AM('ZCC-8 here'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('ZCC-8 here')
})

test('startup: a render before session.start passes through with no $ call; the map landing redraws it decorated', opts({ look: 'suffix' }), async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('early'), props: AM('Restored reply about ZCC-8.'), viewport: VIEW })
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('Restored reply about ZCC-8.')
  await $.session.start(START)
  await ui.drawn()
  expect(w.drawn.at(-1)).toBe('Restored reply about ZCC-8 · ○ Task detail pane.')
})

test('the log, when on: a sibling of the plugin folder, counts and timings only', opts({ look: 'suffix', log: true }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('log'), props: AM('Next is ZCC-8.'), viewport: VIEW })
  await ui.drawn()
  await w.clock.advance(2100)
  const paths = [...w.files.keys()]
  expect(paths.length).toBe(1)
  expect(paths[0]!).toMatch(/[\\/]zinn-logs[\\/]2026-10-12_b7e1c0de-0000-4000-8000-000000000006\.jsonl$/)
  expect(paths[0]!).not.toMatch(/[\\/]zinn[\\/]zinn-logs[\\/]/) // beside the plugin folder, not inside it
  const recs = records(w)
  expect(recs.map(r => r['ev']).slice(0, 2)).toEqual(['session', 'map'])
  expect(JSON.stringify(recs)).not.toContain('Task detail pane')
  expect(JSON.stringify(recs)).not.toContain('Next is')
  console.log('sample render line:', JSON.stringify(recs.find(r => r['ev'] === 'render')))
})

// ---- a press on a legend key opens the pane on that task, which reads it with `zinn task view KEY --json` ------
const VIEW_RUN = (key: string): string[] => ['zinn', 'task', 'view', key, '--json']

test('keyPress off: the stacked legend has no Button and no Markdown', opts({ look: 'under', keyPress: 'off' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('kp0'), props: AM('ZCC-6 and ZCC-99.'), viewport: VIEW })
  await ui.drawn()
  expect((await ui.find({ type: 'Text', text: /^↳ ZCC-6 / }))?.text).toBe('↳ ZCC-6  ◐ Build key-lines MVP: key decorations in…')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
  expect(w.status.at(-1)).toBe('')
})

test('keyPress default is button: a known key is a Button, an unknown key is not, with no option and no variable', opts({ look: 'under' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('kpd'), props: AM('ZCC-6 and ZCC-99.'), viewport: VIEW })
  await ui.drawn()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['key:ZCC-6'])
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
  void w
})

test('keyPress button: a known key is a Button, an unknown key is not; a press opens the pane on that task', opts({ look: 'under', keyPress: 'button' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('kp1'), props: AM('ZCC-6 and ZCC-99.'), viewport: VIEW })
  await ui.drawn()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['key:ZCC-6'])
  expect((await ui.find({ type: 'Button' }))?.text).toBe('ZCC-6')
  await ui.press({ key: 'key:ZCC-6' })
  expect(w.runs.at(-1)).toEqual(VIEW_RUN('ZCC-6'))
  await ui.unmount()
})

test('keyPress link: a Markdown link to the placeholder href; a press on it opens the pane on that task', opts({ look: 'under', keyPress: 'link' }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('kp2'), props: AM('ZCC-6 and ZCC-99.'), viewport: VIEW })
  await ui.drawn()
  const md = await ui.find({ type: 'Markdown' })
  expect(md?.key).toBe('key:ZCC-6')
  expect(md?.text).toBe('[ZCC-6](https://zinn.invalid/ZCC-6)')
  await ui.press({ key: 'key:ZCC-6', link: { href: 'https://zinn.invalid/ZCC-6' } })
  expect(w.runs.at(-1)).toEqual(VIEW_RUN('ZCC-6'))
  await ui.unmount()
})

test('keyPress from the variable ZINN_MENTIONS_KEY_PRESS; the one-line legends and the overflow row get none', opts({ look: 'under' }), async ($, on) => {
  const w = world(on, { env: { ZINN_MENTIONS_KEY_PRESS: 'button', ZINN_MENTIONS_MAX_ENTRIES: '1' } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('kp3'), props: AM('ZCC-6, ZCC-7 and ZCC-8.'), viewport: VIEW })
  await ui.drawn()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['key:ZCC-6']) // ZCC-7, ZCC-8 are behind "+2 more"
  void w
})

test('keyPress with the pane off: a press reads nothing, one toast says so, nothing else breaks', opts({ look: 'under', keyPress: 'button', pane: false }), async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId('kp4'), props: AM('ZCC-6.'), viewport: VIEW })
  await ui.drawn()
  const runs = w.runs.length
  const toasts = w.toasts.length
  await ui.press({ key: 'key:ZCC-6' })
  expect(w.runs.length).toBe(runs)
  expect(w.toasts.length).toBe(toasts + 1)
})

// ---- benchmark --------------------------------------------------------------------------------
// ~5,000 synthetic keys, a ~10k-character block with ~50 mentions, 200 renders per look through the hook.
// `ownMs` is the hook's synchronous work (performance.now), without next() and without any $ call.
const BENCH_ROWS = Array.from({ length: 5000 }, (_, i) => ({ key: `P${i % 50}-${i}`, status: i % 7 === 0 ? 'Archived' : 'Active', column: ['TODO', 'In Progress', 'Done', 'Review'][i % 4], title: `Synthetic task number ${i} with a title of some length` }))
function benchText(salt: number): string {
  let text = ''
  for (let i = 0; text.length < 10000; i++) {
    const j = (i * 37 + salt) % 5000
    text += `Paragraph ${i} mentions **P${j % 50}-${j}** and \`code\` and then goes on with filler words, long enough that about fifty of these fill roughly ten thousand characters of one reply block. ` + (i % 5 === 4 ? '\n\n' : '')
  }
  return text + 'end.'
}
for (const look of ['off', 'suffix', 'brackets', 'colour', 'under'] as const) {
  test(`benchmark ${look}: 200 renders of a ~10k block, ~50 mentions, 5,000 keys`, { options: { look, log: true }, timeoutMs: 120000 }, async ($, on) => {
    const w = world(on, { zinn: { exitCode: 0, stdout: JSON.stringify(BENCH_ROWS) } })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'zinn', surface: 'terminal', component: 'AssistantMessage', requestId: nextId(`bench-${look}`), props: AM(benchText(0)), viewport: VIEW })
    await ui.drawn()
    for (let i = 1; i < 200; i++) await ui.redraw(AM(benchText(i)))
    await ui.unmount()
    await w.clock.advance(2100)
    const renders = records(w).filter(r => r['ev'] === 'render')
    expect(renders.length).toBe(200)
    const own = renders.map(r => Number(r['ownMs'])).sort((a, b) => a - b)
    const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))]!
    console.log(`BENCH ${look}: own p50=${pct(own, 50)} p95=${pct(own, 95)} max=${own.at(-1)} | calls max=${Math.max(...renders.map(r => Number(r['calls'])))} | known(median)=${pct(renders.map(r => Number(r['known'])).sort((a, b) => a - b), 50)} | fallbacks max=${Math.max(...renders.map(r => Number(r['fallbacks'])))}`)
    expect(renders.every(r => r['did'] === (look === 'off' ? 'pass' : 'decorated'))).toBe(true)
  })
}
