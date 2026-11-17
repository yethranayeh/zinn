// The styles a decoration's pieces get. Pure.
//
// Colour floor: every decoration reads with colour off. Colour
// only reinforces a meaning that a character (glyph, word, bracket, the ✗ mark) or bold/dim already
// carries. Colours are Claude Code THEME KEYS only, never hex, rgb or 256-colour values, so the person's
// theme and the engine's own colour-depth detection decide what is painted. The mod never forces a depth.

/** What hooks/mentions.tsx spreads onto a Text: a subset of the engine's TextProps. */
export type SpanStyle = {
  color?: ThemeColor
  dimColor?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

/** One run of text with one style. A line is a list of spans. A block is a list of lines. */
export type Span = { s: string; style: SpanStyle }

/** The theme keys this mod uses (a subset of the engine's `ThemeKey`). */
export type ThemeColor = 'success' | 'warning' | 'error' | 'inactive' | 'subtle' | 'suggestion' | 'permission'
export const THEME_COLORS: readonly ThemeColor[] = ['success', 'warning', 'error', 'inactive', 'subtle', 'suggestion', 'permission']

/**
 * Glyph colour per board column. Chosen against the engine's own six theme tables (lib/themes.ts):
 * - `claude` is not used: in the ANSI themes it is redBright, the same as `error` (dark-ansi), so
 *   "In Progress" would look like "Blocked". `warning` is yellow in every theme.
 * - `suggestion` equals `permission` in every theme, and `permission` is the colour the engine gives
 *   inline code. So a KEY is never coloured `suggestion`: it would look like code. Review's glyph uses it
 *   (a glyph is not code-shaped).
 * - `inactive` equals `subtle` in both ANSI themes: TODO and archived then differ by glyph only (○ vs ▪).
 */
export const COLUMN_COLOR: Readonly<Record<string, ThemeColor>> = {
  'Backlog': 'inactive',
  'TODO': 'inactive',
  'In Progress': 'warning',
  'Review': 'suggestion',
  'Blocked': 'error',
  'Done': 'success',
}

export function markColor(column: string, isArchived: boolean): ThemeColor | undefined {
  if (isArchived) {
    return 'subtle'
  }
  return COLUMN_COLOR[column]
}

/** The known key in an own-drawn block: bold, no colour (see COLUMN_COLOR on why not `suggestion`). */
export const KEY_STYLE: SpanStyle = { bold: true }
/** A key of a known project that the store does not have: bold plus the error colour, and the ✗ mark after it. */
export const UNKNOWN_KEY_STYLE: SpanStyle = { bold: true, color: 'error' }
export const UNKNOWN_MARK_STYLE: SpanStyle = { bold: true, color: 'error' }
export const DIM: SpanStyle = { dimColor: true }

export function sameStyle(a: SpanStyle, b: SpanStyle): boolean {
  return a.color === b.color && !!a.dimColor === !!b.dimColor && !!a.bold === !!b.bold && !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline && !!a.strikethrough === !!b.strikethrough
}

/** Appends a span, merging it into the last one when the style is the same. */
export function pushSpan(line: Span[], s: string, style: SpanStyle): void {
  if (s === '') {
    return
  }
  const last = line[line.length - 1]
  if (last !== undefined && sameStyle(last.style, style)) {
    last.s += s
  } else {
    line.push({ s, style: { ...style } })
  }
}

export const lineText = (line: readonly Span[]): string => line.map(x => x.s).join('')
