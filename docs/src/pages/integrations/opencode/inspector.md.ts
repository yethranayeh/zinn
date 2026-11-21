import type { APIRoute } from "astro";
import { inspectorCollage, opencodeInspector } from "../../../config/opencode-inspector";
import { projectLinks } from "../../../config/site";

export const GET: APIRoute = () =>
  new Response(
    `# ${opencodeInspector.title}

Experimental. ${opencodeInspector.description}

The inspector reads tasks, labels and recorded activity through the local Zinn CLI. It uses the same [data directory and settings](https://zinn.sh/docs/settings) as the CLI running in that environment. It loads active tasks from the default project, or from every project when no default is set. With a remote OpenCode server, the TUI inspector still runs locally and reads the local CLI's database. OpenCode Desktop also shows an experimental board summary for the default project.

## Screenshots

${inspectorCollage.caption}

## Requirements

- OpenCode ${opencodeInspector.verifiedVersion}.
- Zinn CLI ${opencodeInspector.minimumCliVersion} or newer on the terminal's \`PATH\`, with a database it can read.
- The inspector package \`${opencodeInspector.package}\`.

## Install

Install the package in two OpenCode configuration files, keeping any existing plugin entries.

Add it to \`~/.config/opencode/opencode.json\` for the server and desktop entries:

\`\`\`json
{
	"plugins": ["${opencodeInspector.package}"]
}
\`\`\`

Add the same package to \`~/.config/opencode/cli.json\` with the inspector options:

\`\`\`json
{
	"plugins": [
		{
			"package": "${opencodeInspector.package}",
			"options": {
				"rows": 2,
				"current": "glyph"
			}
		}
	]
}
\`\`\`

OpenCode loads the server and desktop entries from \`opencode.json\` and the TUI inspector from \`cli.json\`. Both entries use the same spec, so they share one package download. The \`cli.json\` object carries the TUI options. OpenCode applies \`opencode.json\` options to the server and desktop entries, not to the TUI inspector.

OpenCode loads these entries through its native [plugin configuration](https://opencode.ai/v2/docs/cli/plugins/). Start OpenCode, open a conversation and mention a task key from your database. Select the task to inspect it.

## Find and inspect tasks

Run \`/zinn\` to find a loaded active task. The command palette also offers **Zinn: task keys in this chat** and **Zinn: pick a task from the board**.

Task details include status, priority, labels, the first paragraph of the description, relations, comment count and a short excerpt of the latest mention in the conversation. When the detail is opened from a task key mentioned in this chat, it also says how many times that task was mentioned. Select a related task to open it in the same dialog, then use back to return. Long relation lists scroll in place. Close the dialog with its close control or Esc. Unknown keys are shown when their project prefix appears among the loaded tasks. Select the ZINN heading to refresh task and label data.

## Desktop board summary

OpenCode Desktop shows a board summary in the bottom slot. It follows the default project's board with the active task total, the count in each column with tasks, and when the board was last read. Columns with **done** category are colored green. Backlog and cancelled ones are dimmed.

![OpenCode Desktop with the Zinn bottom slot showing the demo board's task counts](https://res.cloudinary.com/drwbqceye/image/upload/v1795272929/desktop-bottom-slot_nrtl5n.png)

The strip reads the board in the current session's directory. A successful read stamps \`synced HH:MM\`. A failed read keeps the last counts and stamps \`no read\`, with the error on hover.

The ZINN wordmark opens the Zinn documentation. The Zinn settings page turns the strip on or off and sets the refresh interval to 30 seconds, 1 minute, 5 minutes or 15 minutes. The default is 1 minute.

1. **Wordmark.** The ZINN wordmark. It opens the Zinn documentation.
2. **Task total.** The active tasks in the default project.
3. **Column counts.** One cell for each column with tasks, in board order. Backlog and cancelled ones are dimmed.
4. **Category ink.** Columns with the done category are colored green.
5. **Hatched spacer.** The elastic seam between the counts and the read stamp. It absorbs the space the columns leave.
6. **Read stamp.** The last time the board was read. A failed read says no read and keeps the last counts.

## Options

| Option    | Default | Behavior                                                                                                  |
| --------- | ------- | --------------------------------------------------------------------------------------------------------- |
| \`rows\`    | \`1\`     | Accepts \`1\` or \`2\`. \`2\` includes column, priority and labels.                                             |
| \`current\` | \`"off"\` | Accepts \`"off"\` or \`"glyph"\`. \`"glyph"\` marks tasks with recorded activity from this conversation family. |

## Conversation marks

A conversation mark means a task has recorded activity whose session or thread ID matches the current conversation, its root or one of its children. A mention alone does not create a mark. The mark records activity, rather than an assignment or ownership claim.

OpenCode's native shell session ID is recorded by Zinn as a thread ID. An explicit \`ZINN_SESSION_ID\` and \`ZINN_THREAD_ID\` pair takes precedence. The inspector recognizes both routes. See [actor identity](https://zinn.sh/docs/cli/identity#who-am-i) for the CLI contract.

The mark animates while OpenCode reports that conversation as busy. Busy state comes from the host independently of the task's recorded activity. Tasks in Done keep their green treatment.

## Compatibility

Version ${opencodeInspector.version} targets OpenCode 2.3.x, verified on ${opencodeInspector.verifiedVersion}, and its OpenTUI ${opencodeInspector.openTuiVersion} runtime. The \`^0.5.0\` entry installs 0.5.x patches. Move to a new inspector minor only when its release notes name the OpenCode version it supports.

## Update

OpenCode updates the package from the \`opencode.json\` entry. In OpenCode Desktop, open Settings › Extensions › Plugins, select Check for updates, then Update on the package. In the terminal, run \`opencode plugin check\` and \`opencode plugin update\`.

Both entries use the same spec, so an update installs the new 0.5.x package for both. Restart OpenCode to load the new TUI inspector and desktop entry. An exact version is skipped by the update check, so keep the \`^0.5.0\` range.

## Remove

Remove the package entry from each configuration file where you added it, then start OpenCode again. Your Zinn projects, tasks and activity remain in the database.

Verified with OpenCode ${opencodeInspector.verifiedVersion}.

[Inspector source](${projectLinks.github}/tree/main/integrations/opencode/inspector)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
