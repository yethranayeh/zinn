# Zinn actions for Rex

Rex palette actions that work with your Zinn tasks.

## Actions

**Zinn: New task** (`zinn_new_task`) asks for a title first. Then, it asks a followup question for which project it should belong to. On macOS and Windows, you get a notification once it is created. Elsewhere, the palette shows the created task.

**Zinn: Insert task** (`zinn_insert_task`) lets you pick an open task. When you pick it, the task's key, title and description are insserted to the input area of whatever is running in the pane. It's just a glorified copy/paste action for a task's details.

**Zinn: Resume session** (`zinn_resume_session`) lets you pick an open task and opens the Claude Code, OpenCode or Codex conversation that changed it in a new tab. The tab is autonamed after the task. If and when several sessions changed a task, it will first asks which agent session you would like to continue with. If a tab it opened for that conversation is still running, it focuses that tab instead.

The list holds the 2000 most recently active open tasks.

> [!CAUTION]
> Nothing is pasted when the task text contains terminal control characters, when the program in the pane changed while you picked, or when that program does not accept pasted text.

## Requirements

- Rex with `rex.ui` prompts
- The `zinn` command on the PATH of the Rex server or of your login shell. The actions run where the server runs and use the database `zinn` uses there.

## Install

Put the `zinn` folder beside your Rex `init.lua`, usually in `~/.config/rex/`:

```sh
curl -fsSL https://codeload.github.com/yethranayeh/zinn/tar.gz/main | tar -xz -C ~/.config/rex --strip-components=3 zinn-main/integrations/rex/zinn
```

Then load it in `init.lua` and run `rex config reload`:

```lua
require("zinn")
```

On Windows, the folder goes in `%AppData%\rex\`. Windows 10 and later include `curl` and `tar`, so in Command Prompt:

```bat
curl -fsSL https://codeload.github.com/yethranayeh/zinn/tar.gz/main | tar -xz -C "%AppData%\rex" --strip-components=3 zinn-main/integrations/rex/zinn
```

To load one action only, require it by name, such as `require("zinn.new_task")`.

## Keys and arguments

The actions come without any key bindings. You can optionally bind keys to them in `init.lua`:

```lua
rex.bind("cmd+alt+n", "zinn_new_task")
rex.bind("cmd+i", "zinn_insert_task")
rex.bind("cmd+alt+r", "zinn_resume_session")
```

The actions can also take arguments, and they don't ask for any value they are given. With `project`, Zinn: New task files the task there without asking:

```lua
rex.bind("cmd+alt+n", "zinn_new_task", { project = "WEB" })
```

With `title` as well, it asks nothing, which suits scripts: `rex do zinn_new_task title="Fix the login" project=WEB`.

Zinn: Insert task takes `task` to paste that task without showing the list: `rex.bind("cmd+alt+i", "zinn_insert_task", { task = "WEB-12" })`. Zinn: Resume session takes `task` the same way.

## Zinn commands

Zinn: New task runs `project list` and `task create`, or only `task create` when `project` is given. Zinn: Insert task runs `task list` and `task view`, or only `task view` when `task` is given. Zinn: Resume session runs `task list` and `activity list`, or only `activity list` when `task` is given. None of them runs anything until you use it. Each command declares `zinn-rex:<action>/<version>` in its [client chain](https://zinn.sh/docs/cli/identity#client-chains).
