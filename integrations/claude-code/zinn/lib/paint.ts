// The narrowest honest terminal painter, for the colour test and nothing else. Pure.
//
// The test kit hands back the tree a hook returned, as data, and never paints it. So this module paints a PLAN (lib/plan.ts, the same data
// the hooks turn into elements) into terminal text with SGR escapes, the way the 2.1.296 engine's colour
// code does:
// - depth 0 (no colour): chalk at level 0 emits no escape at all, bold and dim included.
// - depth 1 (16 colours): `ansi:<name>` -> SGR 30-37/90-97. `rgb(...)` -> chalk's
//   ansi256ToAnsi(rgbToAnsi256(r,g,b)).
// - depth 2 (256 colours): `ansi:<name>` as at depth 1. `rgb(...)` -> 38;5;n with n from chalk's
//   rgbToAnsi256, or from the engine's own downsampler `E` (it rewrites 38;2 codes to 38;5 below level 3).
//   Which of the two a Text colour goes through is not known, so the test checks both.
// - bold 1, dim 2, italic 3, underline 4, strikethrough 9.
//
// What this proves: which characters a decoration has with colour off, and which SGR colour each theme key
// becomes per theme and depth, i.e. whether two meanings collapse into one colour. What it does NOT prove:
// the engine's Markdown layout (it imitates the subset lib/markdown.ts draws), wrapping, the reply bullet,
// what a terminal's palette makes of a 16-colour code, or anything about the live surface.
import type { Plan, PlanBlock } from './plan'
import { drawBlock, classify } from './markdown'
import type { Span, SpanStyle } from './style'
import type { Theme } from './themes'

export type Depth = 0 | 1 | 2
export type Rgb256 = 'chalk' | 'engine'

const ANSI16: Readonly<Record<string, number>> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  blackBright: 90, redBright: 91, greenBright: 92, yellowBright: 93, blueBright: 94, magentaBright: 95, cyanBright: 96, whiteBright: 97,
}

/** chalk / ansi-styles rgbToAnsi256, as in the 2.1.296 binary. */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) {
      return 16
    }
    if (r > 248) {
      return 231
    }
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
}

/** chalk / ansi-styles ansi256ToAnsi, as in the 2.1.296 binary. */
export function ansi256ToAnsi(code: number): number {
  if (code < 8) {
    return 30 + code
  }
  if (code < 16) {
    return 90 + (code - 8)
  }
  let red: number, green: number, blue: number
  if (code >= 232) {
    red = ((code - 232) * 10 + 8) / 255
    green = red
    blue = red
  } else {
    const c = code - 16
    const rem = c % 36
    red = Math.floor(c / 36) / 5
    green = Math.floor(rem / 6) / 5
    blue = (rem % 6) / 5
  }
  const value = Math.max(red, green, blue) * 2
  if (value === 0) {
    return 30
  }
  let result = 30 + ((Math.round(blue) << 2) | (Math.round(green) << 1) | Math.round(red))
  if (value === 2) {
    result += 60
  }
  return result
}

const CUBE = [0, 95, 135, 175, 215, 255]
/** The engine's own rgb -> 256 downsampler (`function E` beside its 38;2 -> 38;5 rewrite, 2.1.296). */
export function engineAnsi256(r: number, g: number, b: number): number {
  const q = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : v < 155 ? 2 : v < 195 ? 3 : v < 235 ? 4 : 5)
  const o = q(r), gg = q(g), t = q(b)
  const cube = 16 + 36 * o + 6 * gg + t
  const avg = Math.round((r + g + b) / 3)
  if (avg < 5) {
    return 16
  }
  if (avg > 244 && o === gg && gg === t) {
    return cube
  }
  const step = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)))
  const grey = 232 + step
  const gv = 8 + step * 10
  const dc = (r - CUBE[o]!) ** 2 + (g - CUBE[gg]!) ** 2 + (b - CUBE[t]!) ** 2
  return (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2 < dc ? grey : cube
}

/** The SGR colour parameter a theme value becomes at a depth: '' at depth 0. */
export function colourCode(value: string | undefined, depth: Depth, rgb256: Rgb256 = 'chalk'): string {
  if (depth === 0 || value === undefined) {
    return ''
  }
  if (value.startsWith('ansi:')) {
    const c = ANSI16[value.slice(5)]
    return c === undefined ? '' : String(c)
  }
  const m = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/.exec(value)
  if (!m) {
    return ''
  }
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (depth === 1) {
    return String(ansi256ToAnsi(rgbToAnsi256(r, g, b)))
  }
  return `38;5;${rgb256 === 'engine' ? engineAnsi256(r, g, b) : rgbToAnsi256(r, g, b)}`
}

export type PaintOptions = { depth: Depth; theme: Theme; rgb256?: Rgb256 }

export function paintSpan(sp: Span, o: PaintOptions): string {
  if (o.depth === 0 || sp.s === '') {
    return sp.s
  }
  const st: SpanStyle = sp.style
  const codes: string[] = []
  if (st.bold) {
    codes.push('1')
  }
  if (st.dimColor) {
    codes.push('2')
  }
  if (st.italic) {
    codes.push('3')
  }
  if (st.underline) {
    codes.push('4')
  }
  if (st.strikethrough) {
    codes.push('9')
  }
  if (st.color) {
    const c = colourCode(o.theme[st.color], o.depth, o.rgb256)
    if (c !== '') {
      codes.push(c)
    }
  }
  return codes.length === 0 ? sp.s : `\x1b[${codes.join(';')}m${sp.s}\x1b[0m`
}

export const paintLine = (line: readonly Span[], o: PaintOptions): string => line.map(sp => paintSpan(sp, o)).join('')

/** A Markdown block as the engine would roughly draw it (the subset lib/markdown.ts knows). */
export function markdownLines(text: string): Span[][] {
  const kind = classify(text)
  if (kind === 'fence') {
    const lines = text.split('\n')
    const lang = /^ {0,3}(?:`{3,}|~{3,})\s*(\S*)/.exec(lines[0]!)![1]!
    const body = lines.slice(1, /^ {0,3}(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]!) && lines.length > 1 ? -1 : undefined)
    // the engine: a fence without a language is coloured `permission`; with one it is highlighted (not imitated)
    return body.map(l => [{ s: l, style: lang === '' ? { color: 'permission' } : {} }])
  }
  const drawn = drawBlock(text, [], () => [], () => ({}))
  return drawn ?? text.split('\n').map(l => [{ s: l, style: {} }])
}

function blockLines(b: PlanBlock): Span[][] {
  return b.t === 'spans' ? b.lines : markdownLines(b.text)
}

/** Lines of spans for a whole message under a plan (blocks separated by one blank line, as the engine does). */
export function planLines(original: string, plan: Plan, markdown: boolean): Span[][] {
  const md = (text: string): Span[][] => {
    if (!markdown) {
      return text.split('\n').map(l => [{ s: l, style: {} }])
    }
    const out: Span[][] = []
    for (const block of splitBlocks(text)) {
      if (out.length > 0) {
        out.push([])
      }
      out.push(...markdownLines(block))
    }
    return out
  }
  switch (plan.kind) {
    case 'pass': return md(original)
    case 'rewrite': return md(plan.text)
    case 'under': return [...md(original), ...plan.lines]
    case 'own': {
      const out: Span[][] = []
      for (const b of plan.blocks) {
        if (out.length > 0) {
          out.push([])
        }
        out.push(...blockLines(b))
      }
      return out
    }
  }
}

export function paintPlan(original: string, plan: Plan, markdown: boolean, o: PaintOptions): string {
  return planLines(original, plan, markdown).map(l => paintLine(l, o)).join('\n')
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

// local, to avoid importing plan.ts's value (keeps paint usable from a plan built elsewhere)
function splitBlocks(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      cur.push(line)
      if (m && line.trim() === m[1] && m[1]![0] === fence[0] && m[1]!.length >= fence.length) { out.push(cur.join('\n')); cur = []; fence = null }
    } else if (m) {
      if (cur.length) {
        out.push(cur.join('\n'))
      }
      cur = [line]
      fence = m[1]!
    } else if (line.trim() === '') {
      if (cur.length) {
        out.push(cur.join('\n'))
      }
      cur = []
    } else {
      cur.push(line)
    }
  }
  if (cur.length) {
    out.push(cur.join('\n'))
  }
  return out
}
