# Zinn task inspector for OpenCode

[![Works with OpenCode](https://zinn.sh/images/badges/opencode-works-with.svg)](https://opencode.ai)

Task inspection in the OpenCode TUI, plus an experimental board summary in OpenCode Desktop. Read mentioned tasks, open their details, and find tasks with `/zinn`.

Requires OpenCode 2.3.2 and Zinn CLI 0.45.0 or newer on `PATH`.

Add `@zinn-dev/opencode@^0.6.0` to the `plugins` array in `~/.config/opencode/opencode.json` for the server and desktop entries. Add the same spec to `~/.config/opencode/cli.json` with your inspector options:

```json
{ "package": "@zinn-dev/opencode@^0.6.0", "options": { "rows": 2, "current": "glyph" } }
```

Read the [setup, options, compatibility, update and removal guide](https://zinn.sh/integrations/opencode/inspector).

## Development

From the repository root:

```sh
bun install --frozen-lockfile
bun run opencode:typecheck
bun run opencode:test
```

For a local checkout, run `bun run build` in `integrations/opencode/inspector`, then use its absolute directory as the package value in an isolated OpenCode `opencode.json` and `cli.json`. Rebuild to apply source changes, or remove the entries to stop loading it.
