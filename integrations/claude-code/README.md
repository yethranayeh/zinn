# Zinn for Claude Code

Experimental. Two Claude Code plugins that bring Zinn into a Claude Code session. Neither adds a tool, a
prompt section or a model turn, so neither costs tokens.

- **`zinn`**: under each reply, a status mark and a short title for every Zinn task key the reply mentions,
  with a key the store does not have flagged as `✗ not in Zinn`. A task under a live claim says until when it
  is held, in local time: `yours until 14:30` for this session's claim, `held until 14:30` for another's.
  `/zinn-show` opens a pane on a task, a board or the list of boards. A dim `zinn` in the prompt footer says
  the plugin is loaded, and names the task this session holds: `zinn ◆ ABC-7`.
- **`zinn-identity`**: declares the session, subagent, model and effort to Zinn in each shell Claude Code
  starts, so Zinn's activity log tells sessions apart. See [actor identity](https://zinn.sh/docs/cli/identity).

## Requirements

- Claude Code with mods (plugins with a hooks module). Tested with 2.1.327.
- The Zinn CLI on `PATH` as `zinn`. Tested with 0.45.0. The plugins read the store through it. Marks follow
  each column's category and claims show, both from 0.45.0. With an older CLI marks follow the column's name
  or its place on the board.

## Install

From a clone of this repository:

```sh
claude plugin marketplace add ./integrations/claude-code
claude plugin install zinn@zinn
claude plugin install zinn-identity@zinn
```

Start a new session afterwards. To try a plugin for one session without installing it:

```sh
claude --plugin-dir ./integrations/claude-code/zinn
```

## Use

- `/zinn-show ABC-8` opens a task, `/zinn-show ABC` its board, and `/zinn-show` alone the selected key or
  the list of boards. In the pane, `j` goes back and `q` closes.
- `/zinn` shows what is loaded. `/zinn refresh` reads the store again.
- A click on a key under a reply opens it in the pane (fullscreen terminal).

Options are set with `/plugin`, or for one session with the `ZINN_MENTIONS_*` and `ZINN_TASK_PANE_LAYOUT`
environment variables that each option names.

## Development

`bun run claude-code:check` runs each plugin's checks: the manifest, `claude plugin validate`,
`claude plugin test` and a type check against the running Claude Code's declarations. Claude Code writes
those declarations when a session loads its plugin-authoring skill, so load that skill once after a Claude
Code update. A running session hot-reloads a plugin loaded with `--plugin-dir` when its files change.
