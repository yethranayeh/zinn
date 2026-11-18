// The Zinn pane. `/zinn-show [KEY | PROJECT] [layout]` opens one task, one board, or the list of boards, and the
// person walks between them inside the pane.
//
// This module and ./mentions.tsx are the only code that calls `$`, hooks `on(...)` or builds elements. What it
// draws comes from lib/pane/layouts.ts and lib/pane/views.ts as plain rows. Lib/ never imports the engine.
//
// Zero tokens: ui.render only, no tool, no prompt section, no session.append. The command answers `{}` (no
// text), because a command's text is read by the model on the next request. The store is read by argv only:
// `zinn task view KEY --json` for a task, `zinn project view KEY --json` plus `zinn task list KEY --json` for a
// board, `zinn project list --json` for the list of boards. Nothing is written to a Zinn store.
//
// One read per question: a key from a selection is judged by the `task view` that would load it anyway.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, SessionStartInput, RenderElement } from 'claude-code'
import type { ZinnTaskPaneView } from '../types/index'

import { parseBoard, parseProjects } from '../lib/pane/board'
import { parseConfig, type Config, type EnvReads } from '../lib/pane/config'
import { back, EMPTY, entryName, loadingBoard, loadingProjects, loadingTask, onTop, PROJECTS_KEY, push, settle, TABS, type BoardEntry, type Entry, type PaneView, type ProjectsEntry, type Tab, type TaskEntry } from '../lib/pane/model'
import { commentWord, layoutRows, type Item, type ItemTarget, type Row } from '../lib/pane/layouts'
import { LAYOUTS, parseArgs, resolveTarget, type Layout } from '../lib/pane/resolve'
import { failureOf, parseTask, projectOf } from '../lib/pane/task'
import { sp, type Span } from '../lib/pane/style'
import type { Claim, ClaimCtx } from '../lib/claims'
import { boardIsCut, boardRows, commentRows, descriptionRows, projectRows } from '../lib/pane/views'
import { zinnEnv } from './client'

// The state contract (types/index.d.ts) and the shape lib/pane/model.ts builds must be the same type.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const CONTRACT_MATCHES: Equal<PaneView, ZinnTaskPaneView> = true
void CONTRACT_MATCHES

type Dollar = EngineInterface
const PANE = 'zinn-show'
const COMMAND = 'zinn-show'
/** Bump when an entry's fields change: a session that reloads the plugin then reads an older value as empty. */
const VIEW_SHAPE = 'view-4'
const view = atom({ plugin: 'zinn', key: 'view' } as const, EMPTY, { shape: VIEW_SHAPE })
/** Rows asked of the inline seat per layout (a request. The dock ignores it). */
const ROWS_WANTED: Record<Layout, number> = { card: 8, sectioned: 23, table: 11 }
/** Columns asked of the dock (a request. The inline seat ignores it, and a width the person dragged wins). */
const COLUMNS_WANTED: Record<Layout, number> = { card: 56, sectioned: 72, table: 80 }
const BOARD_SEAT = { rows: 24, columns: 100 } as const
const PROJECTS_SEAT = { rows: 20, columns: 80 } as const

let cfg: Config = parseConfig({}, {})
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160)

type Ran = { ok: true; stdout: string } | { ok: false; code: string | null; error: string }

/** One `zinn` run by argv. Never throws: a failure is a value with the envelope's `code` and one line. */
async function zinn($: Dollar, argv: string[]): Promise<Ran> {
  try {
    const r = await $.process.run(['zinn', ...argv], { timeoutMs: 5000, env: await zinnEnv($, 'pane') })
    if (r.exitCode !== 0 || r.isStdoutTruncated) {
      const f = failureOf(r)
      return { ok: false, code: f.code, error: f.reason }
    }
    return { ok: true, stdout: r.stdout }
  } catch (err) {
    return { ok: false, code: null, error: `zinn did not run: ${errText(err)}` }
  }
}

/**
 * This session's id and the time, so a claim is drawn as this session's or another's, live or expired. Read only
 * when one of `claims` is set: a page without a claim costs no call.
 */
async function claimCtx($: Dollar, claims: ReadonlyArray<Claim | null>): Promise<ClaimCtx | undefined> {
  if (claims.every(c => c === null)) {
    return undefined
  }
  const [me, now] = await Promise.all([$.session.id().catch(() => null), $.clock.now()])
  return { me, now }
}

type Loaded<E> = { entry: E; code: string | null }

async function loadTask($: Dollar, key: string): Promise<Loaded<TaskEntry>> {
  const r = await zinn($, ['task', 'view', key, '--json'])
  if (!r.ok) {
    return { entry: { ...loadingTask(key), state: 'failed', error: r.error }, code: r.code }
  }
  try {
    return { entry: { ...loadingTask(key), state: 'ready', task: parseTask(r.stdout) }, code: null }
  } catch (err) {
    return { entry: { ...loadingTask(key), state: 'failed', error: `bad JSON: ${errText(err)}` }, code: null }
  }
}

/** A board is two reads, side by side: the project (its columns, in order) and its active tasks. */
async function loadBoard($: Dollar, project: string): Promise<Loaded<BoardEntry>> {
  const [p, t] = await Promise.all([zinn($, ['project', 'view', project, '--json']), zinn($, ['task', 'list', project, '--json'])])
  const bad = !p.ok ? p : !t.ok ? t : null
  if (bad !== null) {
    return { entry: { ...loadingBoard(project), state: 'failed', error: bad.error }, code: bad.code }
  }
  try {
    return { entry: { ...loadingBoard(project), state: 'ready', board: parseBoard((p as { stdout: string }).stdout, (t as { stdout: string }).stdout) }, code: null }
  } catch (err) {
    return { entry: { ...loadingBoard(project), state: 'failed', error: `bad JSON: ${errText(err)}` }, code: null }
  }
}

async function loadProjects($: Dollar): Promise<Loaded<ProjectsEntry>> {
  const r = await zinn($, ['project', 'list', '--json'])
  if (!r.ok) {
    return { entry: { ...loadingProjects(), state: 'failed', error: r.error }, code: r.code }
  }
  try {
    return { entry: { ...loadingProjects(), state: 'ready', projects: parseProjects(r.stdout) }, code: null }
  } catch (err) {
    return { entry: { ...loadingProjects(), state: 'failed', error: `bad JSON: ${errText(err)}` }, code: null }
  }
}

const load = ($: Dollar, e: { kind: Entry['kind']; key: string }): Promise<Loaded<Entry>> =>
  e.kind === 'task' ? loadTask($, e.key) : e.kind === 'board' ? loadBoard($, e.key) : loadProjects($)

/** A press inside the pane: the entry goes on the stack as loading, then settles with the CLI's answer. Never throws. */
async function open($: Dollar, target: { kind: Entry['kind']; key: string }): Promise<void> {
  const loading: Entry = target.kind === 'task' ? loadingTask(target.key) : target.kind === 'board' ? loadingBoard(target.key) : loadingProjects()
  await update($, view, v => push(v, loading))
  const { entry } = await load($, target)
  await update($, view, v => settle(v, entry))
}

/** `r`: reads the top entry again. A failed read keeps what is drawn and says why in a toast. */
async function refresh($: Dollar): Promise<void> {
  const cur = await read($, view)
  const top = cur.stack[cur.stack.length - 1]
  if (top === undefined) {
    return
  }
  const { entry } = await load($, top)
  if (entry.state === 'failed') { $.ui.toast(`zinn-show: ${entryName(top)} not re-read: ${entry.error ?? 'not available'}`); return }
  await update($, view, v => settle(v, entry))
  $.ui.toast(`zinn-show: ${entryName(top)} re-read`)
}

async function readEnv($: Dollar): Promise<EnvReads> {
  const none = (): undefined => undefined
  return { layout: await $.env.get('ZINN_TASK_PANE_LAYOUT').catch(none) }
}

/** `/zinn-show <rawArgs>`: a toast for a problem, the pane for success. */
async function showCommand($: Dollar, rawArgs: string): Promise<void> {
  if (!cfg.enabled) { $.ui.toast('the zinn pane is off (option pane = false)'); return }
  const args = parseArgs(rawArgs)
  const named = args.key !== null || args.project !== null || args.bad !== null
  const selected = named ? undefined : (await $.ui.selection().catch(() => undefined))?.text
  const now = await read($, view)
  // `/zinn-show table` with the pane open and nothing else named or selected: only the layout changes.
  if (!named && args.layout !== null && (selected ?? '').trim() === '' && now.stack.length > 0) {
    await update($, view, v => ({ ...v, layout: args.layout }))
    return
  }
  const target = resolveTarget({ args, selection: selected })
  if (target.kind === 'none') { $.ui.toast(target.message); return }
  // Something that cannot be loaded is a toast, not a pane with an error in it. So the entry is loaded before
  // the pane opens. A press inside the pane (`open` above) still settles in place, because a relation or a
  // board row names a real task.
  let entry: Entry
  if (target.kind === 'task') {
    // A selection may hold several key-shaped words (SHA-256, then ABC-8): the first one the store has wins.
    // Only "no such task" moves on to the next word; any other failure is the store's and ends the search.
    let found: TaskEntry | null = null
    let failed: Loaded<TaskEntry> | null = null
    for (const key of target.keys) {
      const got = await loadTask($, key)
      if (got.entry.state === 'ready') { found = got.entry; break }
      failed = failed ?? got
      if (got.code !== 'not_found') { failed = got; break }
    }
    if (found === null) {
      const f = failed!
      $.ui.toast(target.from === 'selection' && f.code === 'not_found'
        ? `zinn-show: ${target.keys[0]} is not a task in the store`
        : `zinn-show: ${f.entry.key}: ${f.entry.error ?? 'not available'}`)
      return
    }
    entry = found
  } else {
    const got = target.kind === 'board' ? await loadBoard($, target.project) : await loadProjects($)
    if (got.entry.state === 'failed') { $.ui.toast(`zinn-show: ${entryName(got.entry)}: ${got.entry.error ?? 'not available'}`); return }
    entry = got.entry
  }
  if (args.layout !== null) {
    await update($, view, v => ({ ...v, layout: args.layout }))
  }
  const layout = args.layout ?? now.layout ?? cfg.layout
  await update($, view, v => push(v, entry))
  const seat = entry.kind === 'task' ? { rows: ROWS_WANTED[layout], columns: COLUMNS_WANTED[layout] } : entry.kind === 'board' ? BOARD_SEAT : PROJECTS_SEAT
  const opened = await $.ui.open({ id: PANE, title: entryName(entry), focus: true, rows: seat.rows, columns: seat.columns })
  if (!opened.isPlaced) {
    $.ui.toast(`zinn-show: pane waits undrawn (${opened.reason})`)
  }
  return
}

/** Opens the pane on one task, as `/zinn-show KEY` does. The legend's key press uses it. */
export async function showKey($: Dollar, key: string): Promise<void> {
  await showCommand($, key)
}

export const registerPane = (on: On, options: PluginOptions): void => {

  // The answer carries no text: a toast for a problem, the pane for success.
  on('command.run', { command: COMMAND }, async ($, e) => {
    await showCommand($, e.args)
    return {}
  }).catch(($, _e, _next) => {
    $.ui.toast('zinn-show: /zinn-show failed')
    return {}
  })

  // No Esc. The engine takes Escape to hand the keys back, so a pane that used Esc to step back left the next Esc
  // to the composer, where it interrupts a running turn. Back is `j`, close is `q` (the buttons in the footer), and
  // `closeOnEscape` is not set. Any close that does arrive (the close mark, `q`) resets the view.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, view, v => ({ ...EMPTY, layout: v.layout }))
    return next(e)
  }).catch(($, e, next) => next(e)) // a failing hook never traps the pane: the close goes through

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text: Txt, Button, Markdown } = $.ui.resolve(e)
    const T = (s: Span, k: number) => (Object.keys(s.style).length === 0 ? s.s : <Txt key={String(k)} {...s.style}>{s.s}</Txt>)
    const v = await read($, view)
    const top = v.stack[v.stack.length - 1]
    const width = e.props.bodyColumns
    const layout: Layout = v.layout ?? cfg.layout
    const line = (spans: readonly Span[], wrap: 'wrap' | 'truncate' = 'wrap') => <Txt wrap={wrap}>{spans.map(T)}</Txt>
    // A minimized pane on the desktop app: one line that reads at a glance, no buttons (clicks may not reach it).
    if (e.props.placement === 'widget') {
      return <Txt wrap="truncate">{top === undefined ? 'Zinn' : `Zinn · ${entryName(top)}`}</Txt>
    }
    const go = (t: ItemTarget) => () => { void open($, t) }
    const item = (i: Item) => (
      <Button key={`open:${i.target.key}`} plain hotkey={i.n > 0 ? String(i.n) : undefined} onPress={go(i.target)}>{i.spans.map(T)}</Button>
    )
    const draw = (rows: readonly Row[]): RenderElement[] => rows.map((r, i) => {
      if (r.kind === 'blank') {
        return <Txt key={`b${i}`}> </Txt>
      }
      if (r.kind === 'md') {
        return <Box key={`m${i}`}><Markdown text={r.text} /></Box>
      }
      if (r.kind === 'line') {
        return <Box key={`l${i}`}>{line(r.spans, r.wrap === true ? 'wrap' : 'truncate')}</Box>
      }
      if (r.kind === 'rels') {
        return <Box key={`r${i}`} flexDirection="row" flexWrap="wrap" columnGap={2}>{r.items.map(item)}</Box>
      }
      return <Box key={`e${i}`} flexDirection="row"><Box flexShrink={0}><Txt wrap="truncate">{r.lead.map(T)}</Txt></Box>{item(r.item)}</Box>
    })
    const failedLine = (x: Entry) => [line([sp('✗ ', { color: 'error', bold: true }), sp(entryName(x), { bold: true }), sp(`  ${x.error ?? 'not available'}`, { dimColor: true })])]
    let body: RenderElement[]
    if (top === undefined) {
      body = [line([sp('nothing opened: /zinn-show KEY, /zinn-show PROJECT, or /zinn-show for the boards', { dimColor: true })])]
    } else if (top.state === 'loading') {
      body = [line([sp(`loading ${entryName(top)}…`, { dimColor: true })])]
    } else if (top.kind === 'task') {
      body = top.state === 'failed' || top.task === null ? failedLine(top)
        : draw(top.tab === 'description' ? descriptionRows(top.task, { width }) : top.tab === 'comments' ? commentRows(top.task, { width }) : layoutRows(layout, top.task, { width, claims: await claimCtx($, [top.task.claim]) }))
    } else if (top.kind === 'board') {
      body = top.state === 'failed' || top.board === null ? failedLine(top) : draw(boardRows(top.board, { width, showAll: top.showAll, claims: await claimCtx($, top.board.columns.flatMap(c => c.tasks.map(t => t.claim))) }))
    } else {
      body = top.state === 'failed' || top.projects === null ? failedLine(top) : draw(projectRows(top.projects, { width }))
    }

    // ---- the footer: chrome, one row per kind of choice, the keys always written out --------------------
    const footer: RenderElement[] = []
    if (top !== undefined && top.kind === 'task' && top.state === 'ready' && top.task !== null) {
      const count = top.task.commentCount
      const label: Record<Tab, string> = { overview: 'overview', description: 'description', comments: count === 0 ? 'comments' : commentWord(count) }
      const hot: Record<Tab, string> = { overview: 'o', description: 'd', comments: 'm' }
      const setTab = (tab: Tab) => () => { void update($, view, x => onTop(x, t => (t.kind === 'task' ? { ...t, tab } : t))) }
      footer.push(
        <Box key="tabs" flexDirection="row" columnGap={2}>
          {TABS.map(tab => <Button key={`tab:${tab}`} plain hotkey={hot[tab]} dimColor={tab !== top.tab} onPress={setTab(tab)}>{label[tab]}</Button>)}
        </Box>,
      )
      // The layout switch belongs to the overview: the other two pages have one form.
      if (top.tab === 'overview') {
        footer.push(
          <Box key="switch" flexDirection="row" columnGap={2}>
            {LAYOUTS.map(l => (
              <Button key={`layout:${l}`} plain hotkey={l[0]} dimColor={l !== layout} onPress={() => { void update($, view, x => ({ ...x, layout: l })) }}>{l}</Button>
            ))}
          </Box>,
        )
      }
    }
    // j: back one entry, and close when nothing is behind; q: close. Letters, not Esc (see the ui.close hook).
    const goBack = () => {
      void read($, view).then(async cur => {
        const prev = back(cur)
        if (prev !== null) {
          await update($, view, () => prev)
        } else {
          await $.ui.close({ id: PANE })
        }
      })
    }
    const depth = v.stack.length
    const under = v.stack[depth - 2]
    const nav: RenderElement[] = [
      <Button key="nav:back" plain hotkey="j" onPress={goBack}>{under !== undefined ? `back to ${entryName(under)}${depth > 2 ? ` (${depth - 1} behind)` : ''}` : 'back (closes)'}</Button>,
    ]
    // Up one level, when that level is not already the entry underneath: a task's board, a board's list.
    if (top !== undefined && top.kind === 'task' && !(under !== undefined && under.kind === 'board' && under.key === projectOf(top.key))) {
      nav.push(<Button key="nav:board" plain hotkey="b" onPress={go({ kind: 'board', key: projectOf(top.key) })}>{`${projectOf(top.key)} board`}</Button>)
    }
    if (top !== undefined && top.kind === 'board') {
      if (top.board !== null && boardIsCut(top.board)) {
        nav.push(<Button key="nav:all" plain hotkey="a" onPress={() => { void update($, view, x => onTop(x, t => (t.kind === 'board' ? { ...t, showAll: !t.showAll } : t))) }}>{top.showAll ? 'fewer' : 'all tasks'}</Button>)
      }
      if (!(under !== undefined && under.kind === 'projects')) {
        nav.push(<Button key="nav:boards" plain hotkey="p" onPress={() => { void open($, { kind: 'projects', key: PROJECTS_KEY }) }}>boards</Button>)
      }
    }
    if (top !== undefined && top.state !== 'loading') {
      nav.push(<Button key="nav:refresh" plain hotkey="r" onPress={() => { void refresh($) }}>re-read</Button>)
    }
    nav.push(<Button key="nav:close" plain hotkey="q" onPress={() => { void $.ui.close({ id: PANE }) }}>close</Button>)
    footer.push(<Box key="hint" flexDirection="row" columnGap={2}>{nav}</Box>)
    return <Box flexDirection="column">{body}<Txt> </Txt>{footer}</Box>
  })
}

/** The part's `session.start`, which register.tsx runs. */
export async function startPane(options: PluginOptions, $: Dollar, e: SessionStartInput): Promise<void> {
  cfg = parseConfig(options, await readEnv($))
  if (cfg.enabled) {
    try {
      // `immediate` lets a press inside the pane run mid-turn. A command typed mid-turn still waits for idle.
      await $.command.register({ name: COMMAND, description: 'Zinn pane: /zinn-show KEY a task, /zinn-show PROJECT its board, /zinn-show alone the selection or the list of boards', argumentHint: '[KEY | PROJECT] [layout]', immediate: true })
    } catch (err) {
      $.ui.log(`zinn: command refused: ${errText(err)}`)
    }
  }
}
