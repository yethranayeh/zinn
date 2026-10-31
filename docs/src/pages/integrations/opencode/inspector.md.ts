import type { APIRoute } from "astro";
import { opencodeInspector } from "../../../config/opencode-inspector";
import { projectLinks } from "../../../config/site";

export const GET: APIRoute = () =>
  new Response(
    `# ${opencodeInspector.title}

Experimental. ${opencodeInspector.description}

The inspector reads tasks, labels and recorded activity through the local Zinn CLI. It uses the same [data directory and settings](https://zinn.sh/docs/settings) as the CLI running in that environment. It loads active tasks from the default project, or from every project when no default is set. With a remote OpenCode server, the inspector still runs locally and reads the local CLI's database.

## Requirements

- OpenCode ${opencodeInspector.verifiedVersion}.
- Zinn CLI ${opencodeInspector.minimumCliVersion} or newer on the terminal's \`PATH\`, with a database it can read.
- The inspector package \`${opencodeInspector.package}\`.

## Install

Add the package to \`~/.config/opencode/cli.json\`, keeping any existing plugin entries:

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

OpenCode loads this TUI-only package through its native [CLI plugin configuration](https://opencode.ai/v2/docs/cli/plugins/). Start OpenCode, open a conversation and mention a task key from your database. Select the task to inspect it.

## Find and inspect tasks

Run \`/zinn\` to find a loaded active task. The command palette also offers **Zinn: task keys in this chat** and **Zinn: pick a task from the board**.

Task details include status, priority, labels, relations, comment count and the first paragraph of the description. When the detail is opened from a task key mentioned in this chat, it also says how many times that task was mentioned. Unknown keys are shown when their project prefix appears among the loaded tasks. Select the ZINN heading to refresh task and label data.

## Options

- \`rows\`: values \`1\` and \`2\`, default \`1\`. \`2\` includes column, priority and labels.
- \`current\`: values \`"off"\` and \`"glyph"\`, default \`"off"\`. \`"glyph"\` marks tasks with recorded activity from this conversation family.

## Conversation marks

A conversation mark means a task has recorded activity whose session or thread ID matches the current conversation, its root or one of its children. A mention alone does not create a mark. The mark records activity, rather than an assignment or ownership claim.

OpenCode's native shell session ID is recorded by Zinn as a thread ID. An explicit \`ZINN_SESSION_ID\` and \`ZINN_THREAD_ID\` pair takes precedence. The inspector recognizes both routes. See [actor identity](https://zinn.sh/docs/cli#who-am-i) for the CLI contract.

The mark animates while OpenCode reports that conversation as busy. Busy state comes from the host independently of the task's recorded activity. Tasks in Done keep their green treatment.

## Compatibility

Version ${opencodeInspector.version} targets OpenCode ${opencodeInspector.verifiedVersion} and its OpenTUI 0.7.0 runtime. Keep the inspector's version pinned when updating OpenCode and check the inspector's compatibility guidance before adopting a new host release.

## Update

Replace the version in the package entry with the compatible inspector version you want, then start OpenCode again. OpenCode manages the package download. Keep your existing options in the entry.

## Remove

Remove the \`${opencodeInspector.packageName}\` entry from \`cli.json\`, then start OpenCode again. Your Zinn projects, tasks and activity remain in the database.

Verified with OpenCode ${opencodeInspector.verifiedVersion}.

[Inspector source](${projectLinks.github}/tree/main/integrations/opencode/inspector)
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
