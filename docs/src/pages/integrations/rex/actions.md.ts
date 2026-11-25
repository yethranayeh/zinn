import type { APIRoute } from "astro";
import { pastedText } from "../../../components/rex-actions/insert-task-rows";
import { rexActions } from "../../../config/rex-actions";
import { projectLinks } from "../../../config/site";

const fence = (language: string, lines: string[]) =>
  `\`\`\`${language}\n${lines.join("\n")}\n\`\`\``;
const fileLinks = rexActions.files
  .map((name) => `[${name}](https://zinn.sh${rexActions.downloadBase}/${name})`)
  .join(", ");

export const GET: APIRoute = () =>
  new Response(
    `# ${rexActions.title}

Two palette actions for [Rex](${rexActions.site}). Zinn: New task files a task. Zinn: Insert task pastes one into the program in the pane, ready for you to send.

## The actions

### Zinn: New task

Asks for a title, then for a project from the list of your projects, and creates the task there. On macOS and Windows, a system notification names the new task. Elsewhere, or when the notification cannot be shown, the palette shows it. Closing either prompt creates nothing.

### Zinn: Insert task

Run it from the terminal pane that should receive the task. It lists the 2,000 most recently active open tasks of all your projects, each with the first line of its description and its column. Filter by key or title and pick one.

The task's key and title, a blank line and its description go into the program in the pane as one bracketed paste. Nothing presses Return, so you can edit the text before you send it. Picking ZINN-334 pastes:

${fence("text", [pastedText])}

Nothing is pasted, and the action stops with a message, when:

- the pane has no running program,
- the program in the pane changed while you picked,
- the program does not accept bracketed paste,
- or the task text contains terminal control characters other than tab and newline.

## Requirements

- Rex with \`rex.ui\` prompts, which need control API revision 17 or later.
- The \`zinn\` command on the \`PATH\` of the Rex server or of your login shell.

The actions run \`zinn\` where the Rex server runs, so they use the database that \`zinn\` [selects](https://zinn.sh/docs/settings#choose-the-data-directory) there. When the server's \`PATH\` has no \`zinn\`, they read your login shell's \`PATH\` once and use that.

## Install the actions

Put the \`zinn\` folder beside your Rex \`init.lua\` and load it there. On macOS and Linux, this downloads the files into \`~/.config/rex/zinn\`, or into \`rex/zinn\` under \`$XDG_CONFIG_HOME\` when that is set:

${fence("sh", rexActions.commands)}

Then load the actions in \`init.lua\`:

${fence("lua", [rexActions.require])}

And reload the configuration:

${fence("sh", [rexActions.reload])}

To load one action only, require it by name, such as \`require("zinn.new_task")\`. Run the download again to update the files. To remove the actions, delete the folder and the \`require\` line.

The download fetches ${fileLinks}.

Rex's [configuration reference](${rexActions.configDocs}) says where \`init.lua\` lives.

On Windows, the folder goes in \`%AppData%\\rex\\\`. Windows 10 and later include \`curl\` and \`tar\`, so in Command Prompt this fetches the folder from GitHub:

${fence("bat", [rexActions.windowsCommand])}

## Keys and arguments

The actions come without key bindings. Bind keys to \`zinn_new_task\` and \`zinn_insert_task\` in \`init.lua\`:

${fence("lua", rexActions.bindings)}

An action asks for nothing it is given as an argument. With \`project\`, Zinn: New task files the task there without asking:

${fence("lua", [rexActions.projectBinding])}

With \`title\` as well, it asks nothing, which suits scripts:

${fence("sh", [rexActions.scriptCommand])}

Zinn: Insert task takes \`task\` to paste that task without showing the list:

${fence("lua", [rexActions.taskBinding])}

## Calls to Zinn

The actions run \`zinn\` only when you use one. While they are unused they make no calls, so none that you did not trigger, in use or idle.

Each use of Zinn: New task makes at most two calls, \`project list\` and \`task create\`, or only \`task create\` when \`project\` is given. Each use of Zinn: Insert task makes at most two, \`task list\` and \`task view\`, or only \`task view\` when \`task\` is given.

Each call names its action in the [client chain](https://zinn.sh/docs/cli/identity#client-chains), as \`zinn-rex:new-task/<version>\` or \`zinn-rex:insert-task/<version>\`.

[Actions source](${projectLinks.github}/tree/main/integrations/rex/zinn) · [Zinn theme for Rex](https://zinn.sh/integrations/rex/theme.md) · [All integrations](https://zinn.sh/integrations)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
