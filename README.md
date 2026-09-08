# zinn

A kanban workflow in the terminal.

## Install

```bash
bun add -g @zinn-dev/cli
```

Requires [Bun](https://bun.sh).

## Usage

```bash
zinn
```

## Development data

Reset the **default Zinn database** and populate it with representative development data:

```bash
bun run dev:seed
```

The seed provides ready to use data for Zinn commands:

```bash
zinn task list
zinn task view APP-1
```

Running `dev:seed` again **deletes** and recreates the database at
`~/.zinn/data/zinn.sqlite`.

## Packages

| Package                           |                                           |
| --------------------------------- | ----------------------------------------- |
| [`@zinn-dev/cli`](packages/cli)   | the `zinn` terminal binary                |
| [`@zinn-dev/tui`](packages/tui)   | the WIP terminal interface                |
| [`@zinn-dev/core`](packages/core) | shared logic the other packages call into |

## License

MIT
