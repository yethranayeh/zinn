# Zinn actions for Rex

Rex palette actions that work with your Zinn tasks.

## Actions

**Zinn: New task** (`zinn_new_task`) asks for a title first. Then, it asks a followup question for which project it should belong to. On macOS and Windows, you get a notification once it is created. Elsewhere, the palette shows the created task.

## Requirements

- Rex with `rex.ui` prompts
- The `zinn` command on the PATH of the Rex server. The actions run where the server runs and use the database `zinn` uses there.

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

The actions come without any key bindings. You can optionally bind a key to it in `init.lua`:

```lua
rex.bind("cmd+alt+n", "zinn_new_task")
```

The action can also take arguments, and it doesn't ask for any value it is given. With `project`, it files the task there without asking:

```lua
rex.bind("cmd+alt+n", "zinn_new_task", { project = "WEB" })
```

With `title` as well, it asks nothing, which suits scripts: `rex do zinn_new_task title="Fix the login" project=WEB`.

## Zinn commands

Zinn: New task runs `project list` and `task create`, or only `task create` when `project` is given. Each command declares `zinn-rex:<action>/<version>` in its [client chain](https://zinn.sh/docs/cli/identity#client-chains).
