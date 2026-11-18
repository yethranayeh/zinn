// The colour floor: every decoration reads with colour off. Scripted, no model.
//
// Each look is rendered by lib/paint.ts from the same plan the hooks draw, at no colour, 16 and 256
// colours, in each of Claude Code 2.1.296's six themes (lib/themes.ts), with both candidate rgb->256
// downsamplers. Hard checks (a failure fails the test):
//   1. no colour: not one escape sequence (chalk at level 0 drops bold and dim too).
//   2. no colour: every known key carries its status mark in characters, next to it (or in the line under).
//   3. no colour: every unknown key carries "✗ not in Zinn" in characters, and no known key does.
//   4. the plan names theme keys only: no hex, rgb, ansi256 or number anywhere in a style.
//   5. 16 and 256 colours: the unknown mark is bold and carries a colour code.
// Findings (printed, not failed): which meanings collapse into one colour code per theme and depth.
// What this does NOT prove is in lib/paint.ts's header: no live paint, no terminal palette, no wrapping.
import { test, expect } from 'claude-code/testing'
import { parseTaskList } from '../lib/keys'
import { planText, type Plan } from '../lib/plan'
import { paintPlan, colourCode, stripAnsi, type Depth, type Rgb256 } from '../lib/paint'
import { THEMES } from '../lib/themes'
import { CATEGORY_LOOK, NAME_LOOK } from '../lib/columns'
import { THEME_COLORS, type Span } from '../lib/style'
import type { Look, Marks } from '../lib/config'
import { PROMPT, ROWS, SAMPLE, SAMPLE_KNOWN, SAMPLE_UNKNOWN } from './fixtures'

declare const console: { log: (...args: unknown[]) => void }

const MAP = parseTaskList(JSON.stringify(ROWS))
const LOOKS: readonly Look[] = ['suffix', 'brackets', 'colour', 'under']
const MARKS: readonly Marks[] = ['shapes', 'words']
const DEPTHS: readonly Depth[] = [0, 1, 2]
const RGB: readonly Rgb256[] = ['chalk', 'engine']

function spansOf(plan: Plan): Span[] {
  if (plan.kind === 'under') {
    return plan.lines.flat()
  }
  if (plan.kind === 'own') {
    return plan.blocks.flatMap(b => (b.t === 'spans' ? b.lines.flat() : []))
  }
  return []
}

/** What sits between a key and its mark with colour off, per look. */
const JOIN: Record<Look, string> = { suffix: ' · ', brackets: ' [', colour: ' · ', under: ' ', off: '' }

for (const markdown of [true, false]) {
  const text = markdown ? SAMPLE : PROMPT
  const known = markdown ? SAMPLE_KNOWN : SAMPLE_KNOWN.filter(([k]) => k === 'ZCC-8' || k === 'ZCC-6')
  const unknown = markdown ? SAMPLE_UNKNOWN : ['ZCC-42']
  for (const look of LOOKS) {
    for (const marks of MARKS) {
      test(`colour gate: ${markdown ? 'reply' : 'prompt'}, ${look}, ${marks}`, async () => {
        const plan = planText(text, MAP, { marks, titleMax: 40, only: null }, look, markdown, 'keep', 'spaced', 0)
        // 4. theme keys only
        for (const sp of spansOf(plan)) {
          if (sp.style.color !== undefined) {
            expect((THEME_COLORS as readonly string[]).includes(sp.style.color)).toBe(true)
          }
        }
        expect(JSON.stringify(plan)).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(|ansi256|"color":\d/)
        for (const [themeName, theme] of Object.entries(THEMES)) {
          for (const depth of DEPTHS) {
            for (const rgb256 of depth === 2 ? RGB : (['chalk'] as const)) {
              const out = paintPlan(text, plan, markdown, { depth, theme, rgb256 })
              const bare = stripAnsi(out)
              const where = `${themeName} depth ${depth} ${rgb256}`
              if (depth === 0) {
                expect([where, out.includes('\x1b')]).toEqual([where, false]) // 1
                for (const [k, shape, word] of known) {
                  const mark = marks === 'shapes' ? shape : word
                  expect([where, k, bare.includes(k + JOIN[look] + mark)]).toEqual([where, k, true]) // 2
                }
                for (const u of unknown) expect([where, u, bare.includes(u + JOIN[look] + (look === 'brackets' ? '' : '') + '✗ not in Zinn')]).toEqual([where, u, true]) // 3
                expect((bare.match(/✗ not in Zinn/g) ?? []).length).toBe(unknown.length) // 3: never on a known key
                if (look === 'colour') {
                  // colour only reinforces: with colour off, the colour look reads exactly as the suffix look
                  const suffix = planText(text, MAP, { marks, titleMax: 40, only: null }, 'suffix', markdown)
                  expect(bare).toBe(stripAnsi(paintPlan(text, suffix, markdown, { depth, theme, rgb256 })))
                }
              } else {
                // 5. the unknown mark: bold (1) and a colour, in whatever this theme makes of `error`
                const err = colourCode(theme['error'], depth, rgb256)
                expect(err === '').toBe(false)
                if (look === 'colour' || look === 'under') {
                  expect([where, new RegExp(`\x1b\\[1;${err.replace(/;/g, ';')}m[^\x1b]*✗ not in Zinn`).test(out)]).toEqual([where, true])
                }
                // the text looks carry no colour: a reply's mark is Markdown bold; a prompt is printable text,
                // so there the characters alone carry it (checked at depth 0 above)
                else if (markdown) {
                  expect(out.includes('\x1b[1m✗ not in Zinn')).toBe(true)
                }
              }
            }
          }
        }
      })
    }
  }
}

test('colour gate findings: which meanings share one colour code, per theme and depth (printed, not failed)', async () => {
  const meanings: [string, string][] = [
    ...Object.entries(CATEGORY_LOOK).filter(([c]) => c !== 'backlog').map(([c, l]): [string, string] => [`mark ${c}`, l.color]),
    ['mark Blocked', NAME_LOOK['Blocked']!.color],
    ['mark archived', 'subtle'], ['unknown ✗', 'error'], ['inline code', 'permission'],
  ]
  const lines: string[] = []
  for (const [themeName, theme] of Object.entries(THEMES)) {
    for (const depth of [1, 2] as const) {
      for (const rgb256 of depth === 2 ? RGB : (['chalk'] as const)) {
        const code = new Map<string, string[]>()
        for (const [label, key] of meanings) {
          const c = colourCode(theme[key], depth, rgb256)
          code.set(c, [...(code.get(c) ?? []), label])
        }
        const same = [...code.values()].filter(v => v.length > 1).map(v => v.join(' = '))
        lines.push(`${themeName.padEnd(16)} ${depth === 1 ? '16 ' : '256'} ${depth === 2 ? rgb256.padEnd(6) : '      '} ${same.length ? same.join('; ') : '(all distinct)'}`)
      }
    }
  }
  console.log('COLOUR FINDINGS\n' + lines.join('\n'))
  expect(lines.length).toBe(6 * 3)
})

test('colour gate samples: the reply under each look, dark theme, no colour and 16 colours (escapes shown as {..})', async () => {
  const show = (s: string): string => s.replace(/\x1b\[([0-9;]*)m/g, (_, c: string) => (c === '0' ? '{/}' : `{${c}}`))
  for (const look of LOOKS) {
    const plan = planText(SAMPLE, MAP, { marks: 'shapes', titleMax: 40, only: null }, look, true, 'keep', 'spaced', 0)
    console.log(`SAMPLE ${look} / no colour\n${paintPlan(SAMPLE, plan, true, { depth: 0, theme: THEMES['dark']! })}`)
    console.log(`SAMPLE ${look} / 16 colours (dark)\n${show(paintPlan(SAMPLE, plan, true, { depth: 1, theme: THEMES['dark']! }))}`)
  }
  expect(true).toBe(true)
})
