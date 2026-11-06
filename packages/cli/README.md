# @zinn-dev/cli

The command-line interface for [Zinn](https://zinn.sh), local kanban and task management for developers and coding agents.

> [!IMPORTANT]
> **Experimental.** Commands, output, and the database schema may change between releases. Save a backup with `zinn backup` before upgrading.

## Install

```sh
npm i -g @zinn-dev/cli
```

Requires [Node.js](https://nodejs.org/) 24.15.0 or newer. See [Install](https://zinn.sh/docs/installation) for package setup and upgrade instructions.

## Use

Create a project and a task, then read the task:

```sh
zinn project create APP --name 'My project'
zinn task create APP --title 'Ship the first feature'
zinn task list APP
zinn task view APP-1
```

Run `zinn --help` to discover commands and `zinn <command> --help` to see usage. See the website's [Quick start](https://zinn.sh/docs/quick-start) for a guided workflow and the [CLI reference](https://zinn.sh/docs/cli) for command behavior.

For related topics, see [Settings](https://zinn.sh/docs/settings), [Scripting and JSON output](https://zinn.sh/docs/scripting), and [Data and backups](https://zinn.sh/docs/data).
