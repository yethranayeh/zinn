// Pure-logic tests of the transcript part. lib/ has no engine import. Only `test`/`expect` come from the kit.
// `claude plugin test` runs them. No model call, no store.
import { test, expect } from 'claude-code/testing'
import { findMentions, parseTaskList, type KeyMap } from '../lib/keys'
import { cutTitle, decoFor, decoText, markFor, rewriteText, titleEchoed, UNKNOWN_MARK } from '../lib/decorate'
import { classify, drawBlock, inline } from '../lib/markdown'
import { keyWidth, KEY_FLOOR_WIDTH, planFor, planText, toBlocks, underLine, underKeys, underLines, UNDER_INDENT } from '../lib/plan'
import { lineText, type Span } from '../lib/style'
import { LEGENDS, parseConfig, parseProjects } from '../lib/config'
import { failureReason, toState } from '../lib/state'
import { footerLabelText, hasFooterLabel, logDirFor, logFileFor, pinnedStatus, statusText, stats } from '../lib/log'
import { paintPlan, stripAnsi } from '../lib/paint'
import { THEMES } from '../lib/themes'
import { restartVerdict, versionCheckApplies } from '../lib/version'
import { clientChain, clientToken } from '../lib/client'
import { ROWS } from './fixtures'

const MAP: KeyMap = parseTaskList(JSON.stringify(ROWS))
const CFG = { marks: 'shapes' as const, titleMax: 40, only: null }
const find = (t: string, only: ReadonlySet<string> | null = null) => findMentions(t, MAP, { repeat: 'first', code: 'skip', only })
const plain = (lines: Span[][]): string => lines.map(lineText).join('\n')

test('anchoring: known decorated, unknown key of a known project flagged; unknown project (UTF-8, FOO-12) ignored', async () => {
  expect(find('See SAM-27 and SAM-99, also ZCC-1.').map(m => `${m.key}:${m.kind}`)).toEqual(['SAM-27:known', 'SAM-99:unknown', 'ZCC-1:known'])
  // A hallucinated PROJECT is not caught.
  expect(find('UTF-8, SHA-256, GPT-4 and FOO-12 are not boards')).toEqual([])
})

test('projects filter: a key of another project is neither decorated nor flagged', async () => {
  const only = parseProjects('zcc')!
  expect(find('SAM-27 SAM-99 ZCC-6 ZCC-99', only).map(m => m.key)).toEqual(['ZCC-6', 'ZCC-99'])
  expect(parseProjects('')).toBe(null)
  expect(parseProjects('*')).toBe(null)
  expect([...parseProjects(' zcc, Sam ;DSGN')!]).toEqual(['ZCC', 'SAM', 'DSGN'])
})

test('keys inside code are skipped, inline and fenced', async () => {
  expect(find('Run `zinn task view ZCC-5` then\n```\nzinn task move ZCC-6 Done\n```\nand ZCC-8').map(m => m.key)).toEqual(['ZCC-8'])
})

test('boundaries hold: URL, slug, file, link target; ZCC-5/ZCC-6 both', async () => {
  expect(find('https://x/SAM-27 and branch 2026-10-09-ZCC-5-rewrite and ZCC-5.md').map(m => m.key)).toEqual([])
  expect(find('ZCC-5/ZCC-6').map(m => m.key)).toEqual(['ZCC-5', 'ZCC-6'])
  expect(find('[ZCC-6](https://x/a) and [see](https://x/ZCC-5)').map(m => m.key)).toEqual(['ZCC-6'])
})

test('marks: shapes per column, words readable without colour; archived wins', async () => {
  const info = (k: string) => MAP.keys.get(k)!
  expect(['SAM-27', 'SAM-2', 'ZCC-5', 'ZCC-7', 'ZCC-8', 'ZCC-1'].map(k => markFor(info(k), 'shapes'))).toEqual(['◐', '●', '◑', '⊘', '○', '▪'])
  expect(['SAM-27', 'SAM-2', 'ZCC-5', 'ZCC-7', 'ZCC-8', 'ZCC-1'].map(k => markFor(info(k), 'words'))).toEqual(['in progress', 'done', 'review', 'blocked', 'todo', 'archived'])
})

test('title cut: max characters with the ellipsis counted; 0 shows the mark only', async () => {
  expect([...cutTitle(ROWS[3]!.title, 40)].length).toBe(40)
  expect(cutTitle(ROWS[3]!.title, 40)).toBe('Build key-lines MVP: key decorations in…')
  expect(cutTitle('short', 40)).toBe('short')
  expect(cutTitle('anything', 0)).toBe('')
  const text = 'ZCC-8 next'
  expect(decoText(decoFor(text, find(text)[0]!, { marks: 'shapes', titleMax: 0 }), 'suffix', 'shapes', true)).toBe(' · ○')
})

test('no repeated title when the text already carries it ("ZCC-5: Spike: does…")', async () => {
  const cases: [string, boolean][] = [
    ['**ZCC-5**: Spike: does rewriting AssistantMessage draw', true],
    ['ZCC-6 (Build key-lines MVP) is next', true],
    ['ZCC-6 — build key-lines mvp: key decorations', true],
    ['Build key-lines MVP: key decorations (ZCC-6)', true],
    ['ZCC-6 is next, then the pane', false],
    ['ZCC-6 builds something', false],
  ]
  for (const [text, want] of cases) {
    const m = find(text)[0]!
    expect([text, titleEchoed(text, m, m.info!.title)]).toEqual([text, want])
  }
  const t = '**ZCC-5**: Spike: does rewriting AssistantMessage draw'
  expect(rewriteText(t, find(t), 'suffix', CFG, true)).toBe('**ZCC-5** · ◑: Spike: does rewriting AssistantMessage draw')
})

test('suffix and brackets rewrite a reply as Markdown: title escaped, unknown bold', async () => {
  const t = 'Next SAM-27, then SAM-99.'
  expect(rewriteText(t, find(t), 'suffix', CFG, true)).toBe('Next SAM-27 · ◐ Calibrate the \\`probe\\` \\| table \\*x\\* \\[y\\], then SAM-99 · **✗ not in Zinn**.')
  expect(rewriteText(t, find(t), 'brackets', CFG, true)).toBe('Next SAM-27 \\[◐ Calibrate the \\`probe\\` \\| table \\*x\\* \\[y\\]\\], then SAM-99 \\[**✗ not in Zinn**\\].')
  expect(rewriteText(t, find(t), 'suffix', { marks: 'words', titleMax: 40 }, true)).toContain('SAM-27 · in progress: Calibrate')
})

test('a prompt is printable text, not Markdown: no backslash escapes, no ** ', async () => {
  const t = 'please do SAM-27 and SAM-99'
  const out = rewriteText(t, find(t), 'suffix', CFG, false)
  expect(out).toBe('please do SAM-27 · ◐ Calibrate the `probe` | table *x* [y] and SAM-99 · ✗ not in Zinn')
  expect(out.includes('\\')).toBe(false)
})

test('inline Markdown: bold, italic, code, strike drawn as styles with their markers hidden; unmatched stays literal', async () => {
  const src = '**In progress**: run `zinn task view` and *see* ~~old~~ 2 * 3 a_b_c \\*lit\\*'
  const { visible } = inline(src)
  const shown = [...src].filter((_, i) => visible[i]).join('')
  expect(shown).toBe('In progress: run zinn task view and see old 2 * 3 a_b_c *lit*')
  const lines = drawBlock(src, [], () => [], () => ({}))!
  const bold = lines[0]!.find(s => s.s === 'In progress')!
  expect(bold.style.bold).toBe(true)
  expect(lines[0]!.find(s => s.s === 'zinn task view')!.style.color).toBe('permission')
  expect(lines[0]!.find(s => s.s === 'see')!.style.italic).toBe(true)
  expect(lines[0]!.find(s => s.s === 'old')!.style.strikethrough).toBe(true)
})

test('block kinds: paragraph, list, heading drawn; tables, quotes, links, nested lists left to the engine', async () => {
  expect(classify('plain text\nsecond line')).toBe('paragraph')
  expect(classify('- one\n- two\n  continued')).toBe('list')
  expect(classify('1. one\n2. two')).toBe('list')
  expect(classify('## Heading ZCC-5')).toBe('heading')
  expect(classify('```\ncode\n```')).toBe('fence')
  for (const b of ['| a | b |\n|---|---|', '> quoted ZCC-5', 'see [x](https://y)', 'go to https://x', '- one\n  - nested', '<b>x</b>']) expect([b, classify(b)]).toEqual([b, 'complex'])
})

test('colour look: a list and a heading keep their formatting; the key is bold; bold/backticks never raw', async () => {
  const text = '## Plan for ZCC-6\n\n- **ZCC-6** is `In Progress`\n- then ZCC-8\n\n| t | ZCC-5 |\n|---|---|'
  const plan = planText(text, MAP, CFG, 'colour')
  expect(plan.kind).toBe('own')
  if (plan.kind !== 'own') {
    return
  }
  expect(plan.fallbacks).toBe(1) // the table: the engine draws it, decorated as text
  const [h, list, table] = plan.blocks
  expect(h!.t).toBe('spans')
  expect(list!.t).toBe('spans')
  expect(table).toEqual({ t: 'md', text: '| t | ZCC-5 · ◑ Spike: does rewriting AssistantMessage/… |\n|---|---|' })
  if (h!.t !== 'spans' || list!.t !== 'spans') {
    return
  }
  expect(plain(h!.lines)).toBe('Plan for ZCC-6 · ◐ Build key-lines MVP: key decorations in…')
  // one decoration per key per message: ZCC-6 was decorated in the heading, so the list mention stays plain
  expect(plain(list!.lines)).toBe('- ZCC-6 is In Progress\n- then ZCC-8 · ○ Task detail pane')
  const all = list!.lines.flat()
  expect(all.some(s => s.s.includes('**') || s.s.includes('`'))).toBe(false)
  expect(all.find(s => s.s === 'ZCC-6')!.style.bold).toBe(true) // the reply's own **bold**
  const key = all.find(s => s.s === 'ZCC-8')!
  expect(key.style.bold).toBe(true) // the mod's key style
  expect(key.style.color).toBe(undefined)
  expect(all.find(s => s.s === '○')!.style.color).toBe('inactive')
  expect(all.find(s => s.s === 'In Progress')!.style.color).toBe('permission') // inline code, as the engine draws it
  expect(all.find(s => s.s === ' Task detail pane')!.style.dimColor).toBe(true)
  const hl = h!.lines.flat()
  expect(hl.find(s => s.s === '◐')!.style.color).toBe('warning')
  expect(hl.find(s => s.s.startsWith('Plan for'))!.style.bold).toBe(true) // a heading is bold
})

test('colour look reads the same as suffix with colour off (colour only reinforces)', async () => {
  const text = 'Next **ZCC-6**, then SAM-99.\n\n- ZCC-8 waits on ZCC-7\n\n1. ZCC-1 is archived'
  const paint = (look: 'suffix' | 'colour') => stripAnsi(paintPlan(text, planText(text, MAP, CFG, look), true, { depth: 0, theme: THEMES['dark']! }))
  expect(paint('colour')).toBe(paint('suffix'))
  expect(paint('colour')).toContain('SAM-99 · ✗ not in Zinn')
})

test('under look: one line, each key once, unknown flagged by characters', async () => {
  const text = 'ZCC-6 and ZCC-6 again, SAM-99 too'
  expect(lineText(underLine(text, find(text), CFG))).toBe('↳ ZCC-6 ◐ Build key-lines MVP: key decorations in…   SAM-99 ✗ not in Zinn')
  expect(planFor({ text, markdown: true, mentions: [], look: 'under', cfg: CFG })).toEqual({ kind: 'pass' })
})

// Legend styles: same pieces, four layouts. Computed by lib/plan.ts, theme keys only.
const LEGEND_TEXT = 'ZCC-6 and ZCC-8, ZCC-6 again, SAM-99 too'
const E6 = 'ZCC-6 ◐ Build key-lines MVP: key decorations in…'
const E8 = 'ZCC-8 ○ Task detail pane'
const E99 = 'SAM-99 ✗ not in Zinn'
const LEGEND_PLAIN: Record<string, string[]> = {
  spaced: [`↳ ${E6}   ${E8}   ${E99}`],
  brackets: [`↳ [${E6}] [${E8}] [${E99}]`],
  dots: [`↳ ${E6} · ${E8} · ${E99}`],
  stacked: [`↳ ZCC-6  ${E6.slice(6)}`, `↳ ZCC-8  ${E8.slice(6)}`, `↳ ${E99}`], // keys padded to the longest (SAM-99)
}
for (const legend of LEGENDS) {
  test(`legend ${legend}: the same entries, each key once, in order; unknown keeps the mark and the error colour`, async () => {
    const lines = underLines(LEGEND_TEXT, find(LEGEND_TEXT), CFG, legend, 0)
    expect(lines.map(lineText)).toEqual(LEGEND_PLAIN[legend])
    const spans = lines.flat()
    expect(spans.find(sp => sp.s.includes('SAM-99'))?.style.color).toBe('error')
    expect(spans.find(sp => sp.s.includes('✗ not in Zinn'))?.style.color).toBe('error')
    expect(spans.filter(sp => sp.style.color !== undefined).every(sp => ['error', 'warning', 'inactive', 'success', 'suggestion', 'subtle'].includes(sp.style.color!))).toBe(true)
    expect(JSON.stringify(spans)).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/)
    expect(lines.every(l => l[0]!.s.startsWith('↳ ') && l[0]!.style.dimColor === true)).toBe(true)
    const plan = planFor({ text: LEGEND_TEXT, markdown: true, mentions: find(LEGEND_TEXT), look: 'under', cfg: CFG, legend, maxEntries: 0 })
    expect(plan).toEqual({ kind: 'under', lines, keys: underKeys(find(LEGEND_TEXT), legend, 0) })
    // Only the stacked legend has a key per line; the key is always its own span, right after the lead.
    const keys = underKeys(find(LEGEND_TEXT), legend, 0)
    if (legend !== 'stacked') {
      expect(keys).toEqual([])
    } else {
      expect(keys).toEqual(['ZCC-6', 'ZCC-8', null]) // SAM-99 is not in the store: not pressable
      keys.forEach((k, i) => {
        if (k !== null) {
          expect(lines[i]![1]!.s).toBe(k)
        }
      })
    }
  })
}

test('legend: default is stacked, for one task and for many (no switch by count); spaced stays an option', async () => {
  for (const text of ['ZCC-6 only', 'ZCC-6 ZCC-8 ZCC-7 ZCC-5 ZCC-1']) {
    const m = find(text)
    expect(underLines(text, m, CFG).length).toBe(new Set(m.map(x => x.key)).size)
    expect(planFor({ text, markdown: true, mentions: m, look: 'under', cfg: CFG })).toEqual(planFor({ text, markdown: true, mentions: m, look: 'under', cfg: CFG, legend: 'stacked' }))
  }
  const t = 'ZCC-6 and ZCC-8'
  expect(lineText(underLine(t, find(t), CFG))).toBe(lineText(underLines(t, find(t), CFG, 'spaced')[0]!))
  const echo = '**ZCC-5**: Spike: does rewriting AssistantMessage text draw… and ZCC-8'
  const words = { marks: 'words' as const, titleMax: 40, only: null }
  expect(underLines(echo, find(echo), words, 'brackets').map(lineText)).toEqual(['↳ [ZCC-5 review: Spike: does rewriting AssistantMessage/…] [ZCC-8 todo: Task detail pane]']) // the legend keeps an echoed title
  expect(UNDER_INDENT).toBe(2)
})

// ---- cap, overflow line, unknown-key rule, padding ------------------------------------------------------
const MANY_TEXT = 'ZCC-6 ZCC-8 ZCC-7 ZCC-5 ZCC-1 SAM-27 SAM-2'
test('cap: default 5 known entries, then one dim "+N more" row, in every style', async () => {
  const m = find(MANY_TEXT)
  for (const legend of LEGENDS) {
    const lines = underLines(MANY_TEXT, m, CFG, legend)
    const last = lines.at(-1)!
    expect(lineText(last)).toBe('↳ +2 more')
    expect(last.every(sp => sp.style.dimColor === true)).toBe(true)
    const shown = lines.slice(0, -1).map(lineText).join('\n')
    expect(['ZCC-6', 'ZCC-8', 'ZCC-7', 'ZCC-5', 'ZCC-1'].every(k => shown.includes(k))).toBe(true)
    expect(shown.includes('SAM-27') || shown.includes('SAM-2')).toBe(false)
  }
  expect(underLines(MANY_TEXT, m, CFG, 'stacked').length).toBe(6) // 5 entries + the overflow row
})

test('cap: a lower number, and 0 or 1000+ means no cap; exactly the cap shows no overflow row', async () => {
  const m = find(MANY_TEXT)
  expect(underLines(MANY_TEXT, m, CFG, 'stacked', 2).map(lineText).at(-1)).toBe('↳ +5 more')
  expect(underLines(MANY_TEXT, m, CFG, 'stacked', 0).length).toBe(7)
  expect(underLines(MANY_TEXT, m, CFG, 'stacked', 7).length).toBe(7)
  expect(underLines(MANY_TEXT, m, CFG, 'stacked', 6).map(lineText).at(-1)).toBe('↳ +1 more')
  const t5 = 'ZCC-6 ZCC-8 ZCC-7 ZCC-5 ZCC-1'
  expect(underLines(t5, find(t5), CFG, 'stacked').some(l => lineText(l).includes('more'))).toBe(false)
})

test('cap counts known keys only: 7 known + 1 unknown, cap 5 -> 5 known lines, then "+2 more | ZCC-99 ✗ not in Zinn"', async () => {
  const t = 'ZCC-6 ZCC-8 ZCC-7 ZCC-5 ZCC-1 SAM-27 SAM-2 ZCC-99'
  for (const legend of LEGENDS) {
    const lines = underLines(t, find(t), CFG, legend)
    const plain = lines.map(lineText)
    expect(plain.at(-1)).toBe('↳ +2 more | ZCC-99 ✗ not in Zinn')
    expect(plain.length).toBe(legend === 'stacked' ? 6 : 2)
    expect(plain.slice(0, -1).join('\n')).not.toContain('ZCC-99')
    const row = lines.at(-1)!
    expect(row.find(sp => sp.s.includes(' | '))?.style.dimColor).toBe(true) // separator is dim (merged with "+2 more")
    expect(row.find(sp => sp.s.includes('+2 more'))?.style.dimColor).toBe(true)
    expect(row.find(sp => sp.s.includes('ZCC-99'))?.style.color).toBe('error') // unknown style kept
    expect(row.find(sp => sp.s.includes('✗ not in Zinn'))?.style.color).toBe('error')
  }
  // a valid key is never pushed out by an unknown one
  const u = 'ZCC-91 ZCC-6 ZCC-8 ZCC-7 ZCC-5 ZCC-1'
  const shown = underLines(u, find(u), CFG, 'stacked').map(lineText)
  expect(shown.slice(0, 5).every(l => !l.includes('✗'))).toBe(true)
  expect(shown.at(-1)).toBe('↳ ZCC-91 ✗ not in Zinn')
})

test('cap: everything fits (known + unknown <= cap) -> reply order, unknown in place, no overflow row', async () => {
  const t = 'ZCC-6 ZCC-99 ZCC-8 ZCC-7 ZCC-5'
  const lines = underLines(t, find(t), CFG, 'stacked').map(lineText)
  expect(lines.length).toBe(5)
  expect(lines[1]!.startsWith('↳ ZCC-99 ✗ not in Zinn')).toBe(true)
  expect(lines.some(l => l.includes('more') || l.includes('|'))).toBe(false)
})

test('cap: unknown-only overflow starts the row with the first unknown entry (no "+0 more")', async () => {
  const t = 'ZCC-6 ZCC-8 ZCC-7 ZCC-91 ZCC-92'
  const lines = underLines(t, find(t), CFG, 'stacked', 3).map(lineText)
  expect(lines.length).toBe(4)
  expect(lines.at(-1)).toBe('↳ ZCC-91 ✗ not in Zinn | ZCC-92 ✗ not in Zinn')
  expect(lines.join('\n')).not.toContain('+0')
})

test('cap: more than 5 unknown keys -> five named, then "+M unknown"; none dropped silently', async () => {
  const t = 'ZCC-6 ZCC-8 ZCC-7 ZCC-5 ZCC-1 SAM-27 ' + [91, 92, 93, 94, 95, 96, 97].map(n => `ZCC-${n}`).join(' ')
  const lines = underLines(t, find(t), CFG, 'stacked')
  const last = lineText(lines.at(-1)!)
  expect(last).toBe('↳ +1 more | ' + [91, 92, 93, 94, 95].map(n => `ZCC-${n} ✗ not in Zinn`).join(' | ') + ' | +2 unknown')
  expect(lines.at(-1)!.find(sp => sp.s.includes('+2 unknown'))?.style.color).toBe('error')
})

test('padding: stacked keys are padded with spaces to the longest key shown; other styles are not padded', async () => {
  const t = 'ZCC-6 ZCC-8 SAM-27 ZCC-100'
  const lines = underLines(t, find(t), CFG, 'stacked').map(lineText)
  expect(lines.length).toBe(4)
  // the mark starts in one column on every line
  const col = lines.map(l => l.search(/[◐○◑⊘●✗▪·]/))
  expect(new Set(col).size).toBe(1)
  expect(lines[0]!.startsWith('↳ ZCC-6   ')).toBe(true)
  // the widest block-key is the pad target: without the long key, the pad shrinks
  const t2 = 'ZCC-6 ZCC-8'
  expect(underLines(t2, find(t2), CFG, 'stacked').map(lineText)[0]!.startsWith('↳ ZCC-6 ◐')).toBe(true)
  expect(underLines(t, find(t), CFG, 'spaced')[0] ? lineText(underLines(t, find(t), CFG, 'spaced')[0]!) : '').not.toMatch(/ZCC-6  /)
  expect(keyWidth(['ZCC-6', 'SAM-27'])).toBe(6)
  expect(keyWidth(['ZCC-6', 'ZKÖ-1'])).toBeGreaterThanOrEqual(KEY_FLOOR_WIDTH) // not plain ASCII: the KEY-000 floor
  expect(KEY_FLOOR_WIDTH).toBe('KEY-000'.length)
})

test('no colour: the stacked, capped legend reads from characters alone (padding and "+N more" are plain text)', async () => {
  const t = MANY_TEXT + ' ZCC-99'
  const plan = planFor({ text: t, markdown: true, mentions: find(t), look: 'under', cfg: CFG })
  const out = paintPlan(t, plan, true, { depth: 0, theme: THEMES['dark']! })
  expect(out.includes('\x1b')).toBe(false)
  expect(out.split('\n').pop()).toBe('↳ +2 more | ZCC-99 ✗ not in Zinn')
})

test('config: legend and own prompts', async () => {
  expect(parseConfig({}, {}).legend).toBe('stacked')
  expect(parseConfig({}, { legend: 'Dots' }).legend).toBe('dots')
  expect(parseConfig({ legend: 'stacked' }, { legend: 'dots' }).legend).toBe('stacked') // userConfig wins
  expect(parseConfig({ legend: 'from-env' }, { legend: 'nope' }).legend).toBe('stacked') // a bad value falls back
  expect(parseConfig({}, {}).myPrompts).toBe(false) // own prompts: left as typed by default
  expect(parseConfig({}, { myPrompts: 'decorate' }).myPrompts).toBe(true) // the variable turns it on
  expect(parseConfig({ myPrompts: 'decorate' }, {}).myPrompts).toBe(true) // so does the option
  expect(parseConfig({ myPrompts: 'leave' }, { myPrompts: 'decorate' }).myPrompts).toBe(false) // userConfig wins
  expect(parseConfig({}, { myPrompts: 'bogus' }).myPrompts).toBe(false)
})

test('config: maxEntries default 5; option beats variable; 0 and 1000+ mean no cap; junk falls back', async () => {
  expect(parseConfig({}, {}).maxEntries).toBe(5)
  expect(parseConfig({}, { maxEntries: '3' }).maxEntries).toBe(3)
  expect(parseConfig({ maxEntries: 'from-env' }, { maxEntries: '8' }).maxEntries).toBe(8)
  expect(parseConfig({ maxEntries: '2' }, { maxEntries: '8' }).maxEntries).toBe(2)
  expect(parseConfig({ maxEntries: 4 }, {}).maxEntries).toBe(4)
  expect(parseConfig({}, { maxEntries: '0' }).maxEntries).toBe(0)
  expect(parseConfig({}, { maxEntries: '1000' }).maxEntries).toBe(0)
  expect(parseConfig({}, { maxEntries: 'many' }).maxEntries).toBe(5)
  expect(parseConfig({}, { maxEntries: '-2' }).maxEntries).toBe(5)
})

test('blocks: blank lines split, a fence is one block', async () => {
  expect(toBlocks('a\n\n```\nx\n\ny\n```\n\nb').map(b => b.text)).toEqual(['a', '```\nx\n\ny\n```', 'b'])
})

test('config: from-env reads the variables; a bad value falls back and says so; defaults cost nothing', async () => {
  const d = parseConfig({}, {})
  expect([d.enabled, d.look, d.marks, d.titleMax, d.only, d.myPrompts, d.tailGuardMs, d.log]).toEqual([true, 'under', 'shapes', 40, null, false, 400, false])
  const e = parseConfig({ look: 'from-env' }, { look: 'Colour', marks: 'words', myPrompts: 'leave', log: '1' })
  expect([e.look, e.lookSource, e.marks, e.myPrompts, e.log]).toEqual(['colour', 'ZINN_MENTIONS_LOOK', 'words', false, true])
  expect(parseConfig({}, { look: 'b-spans' }).lookSource).toContain('is not one of')
  expect(parseConfig({ look: 'under' }, { look: 'colour' }).look).toBe('under') // userConfig wins
  expect(parseConfig({ enabled: false, titleLength: 0 }, {}).titleMax).toBe(0)
})

test('state: the published map and the failure reason (zinn --json errors go to stderr)', async () => {
  const s = toState(MAP, '2026-10-12T09:00:00.000Z', ['zinn', 'task', 'list', '--all', '--json'], null)
  expect([s.status, Object.keys(s.keys).length, s.projects, s.archived]).toEqual(['ready', 7, ['SAM', 'ZCC'], 1])
  expect(s.keys['ZCC-6']!.title).toBe(ROWS[3]!.title)
  expect(toState(null, null, [], 'exit 1: boom').status).toBe('failed')
  expect(failureReason({ exitCode: 1, stderr: '{"error":{"message":"database is locked"}}', isStdoutTruncated: false })).toBe('exit 1: database is locked')
  expect(failureReason({ exitCode: 2, stderr: 'plain words\nmore', isStdoutTruncated: false })).toBe('exit 2: plain words')
  expect(failureReason({ exitCode: 0, stderr: '', isStdoutTruncated: true })).toBe('output over 4 MiB')
})

test('log path is a sibling of the plugin folder, POSIX and Windows; status leads with a failure', async () => {
  expect(logDirFor('/home/a/src/plugins/zinn', '', '/home/a')).toBe('/home/a/.zinn/traces/zinn')
  expect(logDirFor('/home/a/src/plugins/zinn', '', '')).toBe('/home/a/src/plugins/zinn-logs')
  expect(logDirFor('/home/a/src/plugins/zinn', '/var/log/x/', '/home/a')).toBe('/var/log/x')
  expect(logFileFor('/d', '2026-10-12', 'ab-12')).toBe('/d/2026-10-12_ab-12.jsonl')
  expect(statusText({ look: 'suffix', enabled: true, mapNote: 'no decorations (exit 1: boom)', restart: '', own: stats([]), decorated: 0 })).toBe('zinn suffix · no decorations (exit 1: boom)')
  const well = { look: 'under' as const, enabled: true, mapNote: '7 keys', restart: '', own: stats([]), decorated: 0 }
  expect(pinnedStatus('problems', { ...well, hasProblem: false })).toBeUndefined()
  expect(pinnedStatus('problems', { ...well, hasProblem: true })).toBe('zinn under · 7 keys')
  expect(pinnedStatus('always', { ...well, hasProblem: false })).toBe('zinn under · 7 keys')
  expect(pinnedStatus('off', { ...well, hasProblem: true })).toBeUndefined()
  expect([footerLabelText(false), footerLabelText(true)]).toEqual(['zinn', 'zinn ✗'])
  expect([hasFooterLabel(['focus']), hasFooterLabel(['zinnia']), hasFooterLabel(['focus', 'zinn']), hasFooterLabel(['zinn ✗'])]).toEqual([false, false, true, true])
  expect(parseConfig({}, {}).statusLine).toBe('problems')
  expect(parseConfig({ statusLine: 'from-env' }, { statusLine: 'Always' }).statusLine).toBe('always')
  expect(parseConfig({ statusLine: 'off' }, { statusLine: 'always' }).statusLine).toBe('off')
  expect([parseConfig({}, {}).footerLabel, parseConfig({ footerLabel: false }, {}).footerLabel]).toEqual([true, false])
  expect(UNKNOWN_MARK).toBe('✗ not in Zinn')
})

test('version check: a PATH mismatch stops the terminal mod; Claude Desktop skips the check', async () => {
  expect(restartVerdict('2.1.304', '2.1.296 (Claude Code)').verdict).toBe('restart needed')
  expect(restartVerdict('2.1.308', '2.1.308 (Claude Code)').verdict).toBe('current')
  expect(versionCheckApplies('claude-desktop')).toBe(false)
  expect(versionCheckApplies('cli')).toBe(true)
  expect(versionCheckApplies(undefined)).toBe(true)
})

test('ZCC-2 client chain: the inherited chain trimmed, one space, then the part token', () => {
  const token = clientToken('pane', '1.2.3')
  expect(token).toBe('zinn-claude-code:pane/1.2.3')
  expect(clientChain(undefined, token)).toBe(token)
  expect(clientChain(null, token)).toBe(token)
  expect(clientChain(' \t ', token)).toBe(token)
  expect(clientChain(' rex/0.9  zinn-opencode:inspector/0.5.0 ', token)).toBe(`rex/0.9  zinn-opencode:inspector/0.5.0 ${token}`)
})
