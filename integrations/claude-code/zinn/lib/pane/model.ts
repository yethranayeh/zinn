// What the pane keeps in $.state (key `view`): a stack of what was opened (the top
// one is drawn) and the layout in force. An entry is one task, one board, or the list of boards, so `j`
// steps back along the way the person came: boards > ABC > ABC-8 > ABC-6. Pure. types/index.d.ts
// declares the same shape for the engine.
import type { BoardView, ProjectRow } from './board'
import type { TaskView } from './task'
import type { Layout } from './resolve'

export type LoadState = 'loading' | 'ready' | 'failed'

/** Which page of a task is drawn: the layout, the whole description, or the comments. */
export const TABS = ['overview', 'description', 'comments'] as const
export type Tab = (typeof TABS)[number]

export type TaskEntry = {
  kind: 'task'
  key: string
  state: LoadState
  task: TaskView | null
  /** One short line when state is failed. */
  error: string | null
  tab: Tab
}

export type BoardEntry = {
  kind: 'board'
  /** The project key. */
  key: string
  state: LoadState
  board: BoardView | null
  error: string | null
  /** False: the first and the last column are cut to a few rows. True: every task. */
  showAll: boolean
}

export type ProjectsEntry = {
  kind: 'projects'
  /** Always PROJECTS_KEY: there is one list. */
  key: string
  state: LoadState
  projects: ProjectRow[] | null
  error: string | null
}

export type Entry = TaskEntry | BoardEntry | ProjectsEntry

export type PaneView = { stack: Entry[]; layout: Layout | null }

export const EMPTY: PaneView = { stack: [], layout: null }
export const MAX_STACK = 12
export const PROJECTS_KEY = '*'

export const loadingTask = (key: string): TaskEntry => ({ kind: 'task', key, state: 'loading', task: null, error: null, tab: 'overview' })
export const loadingBoard = (key: string): BoardEntry => ({ kind: 'board', key, state: 'loading', board: null, error: null, showAll: false })
export const loadingProjects = (): ProjectsEntry => ({ kind: 'projects', key: PROJECTS_KEY, state: 'loading', projects: null, error: null })

const same = (a: Entry, b: Entry): boolean => a.kind === b.kind && a.key === b.key

/** Push (a new entry on top. The same one as the top is replaced, not stacked), capped. */
export function push(v: PaneView, e: Entry): PaneView {
  const top = v.stack[v.stack.length - 1]
  const base = top !== undefined && same(top, e) ? v.stack.slice(0, -1) : v.stack
  return { ...v, stack: [...base, e].slice(-MAX_STACK) }
}

/**
 * Replace the entry of the same kind and key (the load's answer), wherever it is in the stack. What the
 * person chose on that entry while it loaded or before a refresh (the tab, show all) is kept.
 */
export function settle(v: PaneView, e: Entry): PaneView {
  return {
    ...v,
    stack: v.stack.map(x => {
      if (!same(x, e)) {
        return x
      }
      if (x.kind === 'task' && e.kind === 'task') {
        return { ...e, tab: x.tab }
      }
      if (x.kind === 'board' && e.kind === 'board') {
        return { ...e, showAll: x.showAll }
      }
      return e
    }),
  }
}

/** Changes the top entry in place (a tab, show all). Another kind of top is left alone. */
export function onTop(v: PaneView, change: (top: Entry) => Entry): PaneView {
  const top = v.stack[v.stack.length - 1]
  return top === undefined ? v : { ...v, stack: [...v.stack.slice(0, -1), change(top)] }
}

/** `j`: pop one. Returns null when there is nothing under the top (the pane then closes). */
export function back(v: PaneView): PaneView | null {
  return v.stack.length > 1 ? { ...v, stack: v.stack.slice(0, -1) } : null
}

/** What a tab or a back button calls an entry: `ABC-8`, `ABC board`, `boards`. */
export const entryName = (e: Entry): string => (e.kind === 'task' ? e.key : e.kind === 'board' ? `${e.key} board` : 'boards')
