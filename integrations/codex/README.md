# Zinn for Codex

An Experimental local task inspector and optional task-reference and execution-identity hooks for Codex desktop.

Requires Node.js 24.15.0 or newer and Zinn CLI 0.43.0 or newer on `PATH`. Default-store setup needs no plugin configuration file. The plugin uses the CLI's settings from your home directory, including inherited `ZINN_DIR` and global storage selection.

Read the [setup, permissions, compatibility and removal guide](https://zinn.sh/integrations/codex).

## Development

From the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd integrations/codex --frozen-lockfile
bun run codex:build
bun run codex:package
bun run codex:typecheck
bun run codex:test
```

The build creates a self-contained marketplace at `integrations/codex/dist`. The package command also writes a versioned archive and SHA-256 file under `integrations/codex/release-dist`. Its plugin bundles JavaScript, the inspector HTML and dependency licenses. Consumers use Node and the installed CLI. Bun and the source checkout are build tools.

Register the build with `codex plugin marketplace add ./integrations/codex/dist`, then install Zinn from the Plugins browser and review its hooks. Build output is suitable for a versioned release archive or a dedicated Git marketplace. Building does not install or publish it.
