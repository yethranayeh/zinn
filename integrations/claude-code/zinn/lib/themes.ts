// Claude Code's six built-in themes, for the colour test only (the mod itself never reads a colour value:
// it hands the engine theme KEYS). Pure data.
//
// Source: `strings` of the Claude Code 2.1.296 binary, the objects holding `suggestion:"rgb(...)"` or
// `suggestion:"ansi:..."`. The names are inferred from the values and the engine's theme switch
// (`case"light":… case"light-ansi":… case"dark-ansi":… case"light-daltonized":… case"dark-daltonized":…
// default: dark`): black text = light, white text = dark, ansi: values = the "ANSI colors only" themes.
// Only the keys the test needs are kept. Re-extract on an engine upgrade before trusting a colour finding.
export type ThemeValue = string // 'rgb(r,g,b)' or 'ansi:<name>'
export type Theme = Readonly<Record<string, ThemeValue>>
export const THEMES_VERSION = '2.1.296'
export const THEMES: Readonly<Record<string, Theme>> = {
  'light': { text: 'rgb(0,0,0)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', suggestion: 'rgb(87,105,247)', success: 'rgb(44,122,57)', error: 'rgb(171,43,63)', warning: 'rgb(150,108,30)', claude: 'rgb(215,119,87)', permission: 'rgb(87,105,247)' },
  'light-ansi': { text: 'ansi:black', inactive: 'ansi:blackBright', subtle: 'ansi:blackBright', suggestion: 'ansi:blue', success: 'ansi:green', error: 'ansi:red', warning: 'ansi:yellow', claude: 'ansi:redBright', permission: 'ansi:blue' },
  'dark-ansi': { text: 'ansi:whiteBright', inactive: 'ansi:white', subtle: 'ansi:white', suggestion: 'ansi:blueBright', success: 'ansi:greenBright', error: 'ansi:redBright', warning: 'ansi:yellowBright', claude: 'ansi:redBright', permission: 'ansi:blueBright' },
  'light-daltonized': { text: 'rgb(0,0,0)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', suggestion: 'rgb(51,102,255)', success: 'rgb(0,102,153)', error: 'rgb(204,0,0)', warning: 'rgb(255,153,0)', claude: 'rgb(255,153,51)', permission: 'rgb(51,102,255)' },
  'dark': { text: 'rgb(255,255,255)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', suggestion: 'rgb(177,185,249)', success: 'rgb(78,186,101)', error: 'rgb(255,107,128)', warning: 'rgb(255,193,7)', claude: 'rgb(215,119,87)', permission: 'rgb(177,185,249)' },
  'dark-daltonized': { text: 'rgb(255,255,255)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', suggestion: 'rgb(153,204,255)', success: 'rgb(51,153,255)', error: 'rgb(255,102,102)', warning: 'rgb(255,204,0)', claude: 'rgb(255,153,51)', permission: 'rgb(153,204,255)' },
}
