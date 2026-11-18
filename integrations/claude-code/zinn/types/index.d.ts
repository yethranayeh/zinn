// The $.state contract of the zinn plugin. Self-contained: no import, no reference.
// lib/state.ts and lib/pane/model.ts build the same shapes, and the hooks modules check at compile time
// that they agree.
//
// `map`: every task key in the store with its column and title, read with `zinn task list --all --json`.
// Another plugin reads it with `$.state.get({ plugin: 'zinn', key: 'map' } as const)`. Only zinn writes it.
// `view`: what the pane has open (the top of the stack is drawn) and the layout in force. It is kept under a
// shape tag, so a session that still holds a value of an older build reads it as empty after a reload.

/** A column's category (Zinn 0.45.0 and later). */
export type ZinnColumnCategory = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled'

/** Who holds a task (Zinn 0.45.0 and later). Times are epoch milliseconds. */
export type ZinnClaim = {
  state: 'live' | 'expired'
  actorKind: string
  actorName: string
  sessionId: string | null
  claimedAt: number | null
  expiresAt: number | null
}

export type ZinnKeysEntry = {
  /** The board column as the store names it. */
  column: string
  /** Null when the store gives none of the known values. */
  category: ZinnColumnCategory | null
  /** The full title, uncut. */
  title: string
  isArchived: boolean
}

export type ZinnKeysMap = {
  /** `loading` until the first load settles. `failed` carries `error` and no keys. */
  status: 'loading' | 'ready' | 'failed'
  /** Every key in the store, archived included (`zinn task list --all --json`, read-only, by argv). */
  keys: Record<string, ZinnKeysEntry>
  /** Project keys with at least one task, sorted. */
  projects: string[]
  archived: number
  /** ISO time of the load (engine clock). Null while loading. */
  loadedAt: string | null
  /** The argv that produced it. */
  argv: string[]
  /** One short line on why the last load failed. Null otherwise. */
  error: string | null
}

export type ZinnTaskRelation = {
  type: string
  direction: 'outgoing' | 'incoming'
  verb: string
  key: string
  column: string
  category: ZinnColumnCategory | null
  isFirst: boolean
  isLast: boolean
  title: string
  isArchived: boolean
}

export type ZinnTaskComment = {
  key: string
  text: string
  createdAt: number | null
}

export type ZinnTaskView = {
  key: string
  title: string
  status: string
  column: string
  category: ZinnColumnCategory | null
  isFirst: boolean
  isLast: boolean
  priority: string
  labels: string[]
  relations: ZinnTaskRelation[]
  description: string
  commentCount: number
  comments: ZinnTaskComment[]
  dueAt: number | null
  updatedAt: number | null
  claim: ZinnClaim | null
}

export type ZinnBoardTask = {
  key: string
  title: string
  priority: string
  labels: string[]
  dueAt: number | null
  updatedAt: number | null
  claim: ZinnClaim | null
}

export type ZinnBoardColumn = {
  name: string
  category: ZinnColumnCategory | null
  isFirst: boolean
  isLast: boolean
  tasks: ZinnBoardTask[]
}

export type ZinnBoardView = {
  key: string
  name: string
  columns: ZinnBoardColumn[]
  archivedCount: number
}

export type ZinnProjectRow = { key: string; name: string; active: number; archived: number }

export type ZinnLoadState = 'loading' | 'ready' | 'failed'

export type ZinnTaskEntry = {
  kind: 'task'
  key: string
  state: ZinnLoadState
  task: ZinnTaskView | null
  error: string | null
  tab: 'overview' | 'description' | 'comments'
}

export type ZinnBoardEntry = {
  kind: 'board'
  key: string
  state: ZinnLoadState
  board: ZinnBoardView | null
  error: string | null
  showAll: boolean
}

export type ZinnProjectsEntry = {
  kind: 'projects'
  key: string
  state: ZinnLoadState
  projects: ZinnProjectRow[] | null
  error: string | null
}

export type ZinnPaneEntry = ZinnTaskEntry | ZinnBoardEntry | ZinnProjectsEntry

export type ZinnTaskPaneView = {
  stack: ZinnPaneEntry[]
  layout: 'card' | 'sectioned' | 'table' | null
}

declare module 'claude-code' {
  interface PluginState {
    zinn: {
      map: ZinnKeysMap
      view: Shaped<ZinnTaskPaneView>
    }
  }
}
