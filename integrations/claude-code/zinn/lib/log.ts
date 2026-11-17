// Timing records, the optional JSONL log and the status line. Pure: the hooks module does the I/O. No
// transcript text is ever written, only counts and timings.
import type { Look } from './config'

export type RenderRecord = {
  ev: 'render'
  /** ms since the module loaded (performance.now), so lines order within a load. */
  t: number
  comp: 'AssistantMessage' | 'UserMessage'
  rid: string
  surface: string
  look: Look
  /** decorated | plain (no mention) | held (tail guard) | pass (off, no map yet, expanded, own prompt left) */
  did: string
  why: string
  len: number
  known: number
  unknown: number
  held: number
  /** blocks of an own tree left to the engine and decorated as text (tables, quotes, links) */
  fallbacks: number
  /** the hook's own synchronous work, performance.now, without awaiting next() or any $ call */
  ownMs: number
  /** time spent awaiting the engine's $ calls inside the hook (only the tail guard makes one) */
  waitMs: number
  /** how many $ calls the hook made (0 on every pass-through) */
  calls: number
  totalMs: number
  isSummary: boolean | null
  isExpanded: boolean | null
  isFirstOfReply: boolean | null
  fullscreen: boolean | null
  columns: number | null
}

const round = (n: number): number => Math.round(n * 1000) / 1000

export function renderLine(r: RenderRecord): string {
  return JSON.stringify({ ...r, t: Math.round(r.t), ownMs: round(r.ownMs), waitMs: round(r.waitMs), totalMs: round(r.totalMs) })
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]!
}

export type Stats = { n: number; p50: number; p95: number; max: number }
export function stats(values: readonly number[]): Stats {
  const s = [...values].sort((a, b) => a - b)
  return { n: s.length, p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), max: round(s.at(-1) ?? 0) }
}

/** The one status line. A failure leads, so it is never hidden behind the timing. */
export function statusText(o: { look: Look; enabled: boolean; mapNote: string; restart: string; own: Stats; decorated: number }): string {
  if (o.restart !== '') {
    return `${o.restart}zinn draws nothing until then`
  }
  if (!o.enabled) {
    return 'zinn off (userConfig enabled = false)'
  }
  const timing = o.decorated === 0 ? '' : ` · ${o.decorated} drawn, p95 ${o.own.p95} ms`
  return `zinn ${o.look} · ${o.mapNote}${timing}`
}

/**
 * What is pinned under the prompt, or undefined for no line. The engine draws a pinned line as a notice, so
 * the default pins one only while there is a fault to read; `always` is the line of 0.1.0.
 */
export function pinnedStatus(mode: 'problems' | 'always' | 'off', o: Parameters<typeof statusText>[0] & { hasProblem: boolean }): string | undefined {
  if (mode === 'off') {
    return undefined
  }
  if (mode === 'always') {
    return statusText(o)
  }
  return o.hasProblem ? statusText(o) : undefined
}

/** The mode label at the right of the prompt footer: the one always-on sign that Zinn is loaded. */
export const FOOTER_LABEL = 'zinn'
export const footerLabelText = (hasProblem: boolean): string => (hasProblem ? `${FOOTER_LABEL} ✗` : FOOTER_LABEL)
/** True when the footer already carries a Zinn label (another Zinn mod's, or this one's from a hook above). */
export const hasFooterLabel = (modes: readonly string[]): boolean => modes.some(m => m === FOOTER_LABEL || m.startsWith(`${FOOTER_LABEL} `))

export function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i <= 0) {
    return null
  }
  return trimmed.slice(0, i) || null
}

/** The log folder: the configured one when set, else `<home>/.zinn/traces/zinn`, else — only
 *  when no home directory can be read — a sibling of the plugin folder.
 *
 *  Never the plugin folder itself: a write inside a watched `--plugin-dir` folder hot-reloads the
 *  session. The sibling is the last resort because copying or pulling a repository replaces that tree
 *  wholesale, logs included. */
export function logDirFor(root: string, configured: unknown, home: string | null): string {
  const c = typeof configured === 'string' ? configured.trim() : ''
  if (c !== '') {
    return c.replace(/[\\/]+$/, '')
  }
  const h = (home ?? '').trim().replace(/[\\/]+$/, '')
  if (h !== '') {
    return `${h}/.zinn/traces/zinn`
  }
  const parent = parentDir(root)
  return parent === null ? 'zinn-logs' : `${parent}/zinn-logs`
}

/** The day's session log in `dir`. */
export function logFileFor(dir: string, day: string, sessionId: string): string {
  const name = `${day}_${sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'nosession'}.jsonl`
  return `${dir}/${name}`
}

/** Appends lines to a log's whole text and keeps the last `maxLines` (fs.write replaces the file). */
export function appendCapped(existing: string, lines: readonly string[], maxLines: number): string {
  const all = existing === '' ? [] : existing.split('\n').filter(l => l !== '')
  all.push(...lines)
  return all.slice(-maxLines).join('\n') + '\n'
}
