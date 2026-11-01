# Zinn task inspector for OpenCode

Task inspection in the OpenCode TUI. Read mentioned tasks, open their details, and find tasks with `/zinn`.

Requires OpenCode 2.2.0 and Zinn CLI 0.41.0 or newer on `PATH`.

Add this entry to the `plugins` array in `~/.config/opencode/cli.json`:

```json
{ "package": "@zinn-dev/opencode@0.3.1", "options": { "rows": 2, "current": "glyph" } }
```

Read the [setup, options, compatibility, update and removal guide](https://zinn.sh/integrations/opencode/inspector).

## Development

From the repository root:

```sh
bun install --frozen-lockfile
bun run opencode:typecheck
bun run opencode:test
```

For a local checkout, run `bun run build` in `integrations/opencode/inspector`, then use its absolute directory as the package value in an isolated OpenCode `cli.json`. Rebuild to apply source changes, or remove the config entry to stop loading it.
