import { pastedText } from "./insert-task-rows";
import { rexActions } from "../../config/rex-actions";

export type RexProseElement =
  | { kind: "paragraph"; text: string; markdownHrefOverrides?: Record<string, string> }
  | { kind: "list"; items: string[] }
  | { kind: "details"; summary: string; paragraph: string; code: RexCodeBlock };

export interface RexCodeBlock {
  kind: "code";
  label: string;
  language: string;
  commands: string[];
  showsPrompt?: boolean;
  wraps?: boolean;
}

export type RexActionBlock = { kind: "prose"; blocks: RexProseElement[] } | RexCodeBlock;

export interface RexActionDescription {
  title: string;
  blocks: RexActionBlock[];
}

export interface RexActionSection {
  id: string;
  headingId: string;
  title: string;
  surface: "limestone" | "bone";
  titleSide?: "left" | "right";
  actions?: RexActionDescription[];
  blocks?: RexActionBlock[];
}

export const actionIntroduction = `Three palette actions for [Rex](${rexActions.site}).`;

export const actionSummaries = [
  { action: "Zinn: New task", description: "files a task." },
  {
    action: "Zinn: Insert task",
    description: "pastes one into the program in the pane, ready for you to send.",
  },
  {
    action: "Zinn: Resume session",
    description: "opens the agent conversation that changed one.",
  },
];

const taskPasteExample: RexCodeBlock = {
  kind: "code",
  label: "Text pasted into the program",
  language: "text",
  commands: [pastedText],
  showsPrompt: false,
  wraps: true,
};

export const actionSections: RexActionSection[] = [
  {
    id: "actions",
    headingId: "actions-list-heading",
    title: "The actions",
    surface: "limestone",
    actions: [
      {
        title: "Zinn: New task",
        blocks: [
          {
            kind: "prose",
            blocks: [
              {
                kind: "paragraph",
                text: "Asks for a title, then for a project from the list of your projects, and creates the task there. On macOS and Windows, a system notification names the new task. Elsewhere, or when the notification cannot be shown, the palette shows it. Closing either prompt creates nothing.",
              },
            ],
          },
        ],
      },
      {
        title: "Zinn: Insert task",
        blocks: [
          {
            kind: "prose",
            blocks: [
              {
                kind: "paragraph",
                text: "Run it from the terminal pane that should receive the task. It lists the 2,000 most recently active open tasks of all your projects, each with the first line of its description and its column. Filter by key or title and pick one.",
              },
              {
                kind: "paragraph",
                text: "The task's key and title, a blank line and its description go into the program in the pane as one bracketed paste. Nothing presses Return, so you can edit the text before you send it. Picking ZINN-334 pastes:",
              },
            ],
          },
          taskPasteExample,
          {
            kind: "prose",
            blocks: [
              {
                kind: "paragraph",
                text: "Nothing is pasted, and the action stops with a message, when:",
              },
              {
                kind: "list",
                items: [
                  "the pane has no running program,",
                  "the program in the pane changed while you picked,",
                  "the program does not accept bracketed paste,",
                  "or the task text contains terminal control characters other than tab and newline.",
                ],
              },
            ],
          },
        ],
      },
      {
        title: "Zinn: Resume session",
        blocks: [
          {
            kind: "prose",
            blocks: [
              {
                kind: "paragraph",
                text: "Pick a task from the same list, and the Claude Code, OpenCode or Codex conversation that changed it opens again in a new tab named after the task. The action finds the conversations in the task's [activity](/docs/core/activity#activity-records). When more than one changed the task, a second list shows them, newest first, with their host, model and directory.",
              },
              {
                kind: "paragraph",
                text: "The tab starts a shell in the directory Zinn recorded with the change and runs the host's resume command there: `claude --resume`, `opencode --session` or `codex resume`, with the session ID. When you leave the conversation, the shell stays open. Claude Code resumes a session only from the directory it started in, so for Claude Code the tab starts in the nearest parent of the recorded directory that holds the session.",
              },
              {
                kind: "paragraph",
                text: "When a tab this action opened for the same conversation still runs a program, that tab gets focus and no new tab opens. When no Claude Code, OpenCode or Codex session changed the task, a notification says so and nothing opens.",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "requirements",
    headingId: "requirements-heading",
    title: "Requirements",
    surface: "bone",
    titleSide: "right",
    blocks: [
      {
        kind: "prose",
        blocks: [
          {
            kind: "list",
            items: [
              "Rex with `rex.ui` prompts, which need control API revision 17 or later.",
              "The `zinn` command on the `PATH` of the Rex server or of your login shell.",
              "To resume a conversation, its host's command, `claude`, `opencode` or `codex`, on your shell's `PATH`.",
            ],
          },
          {
            kind: "paragraph",
            text: "The actions run `zinn` where the Rex server runs, so they use the database that `zinn` [selects](/docs/settings#choose-the-data-directory) there. When the server's `PATH` has no `zinn`, they read your login shell's `PATH` once and use that.",
          },
        ],
      },
    ],
  },
  {
    id: "installation",
    headingId: "installation-heading",
    title: "Install the actions",
    surface: "limestone",
    blocks: [
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: "Put the `zinn` folder beside your Rex `init.lua` and load it there.",
          },
          {
            kind: "paragraph",
            text: "On macOS and Linux, this downloads the files into `~/.config/rex/zinn`, or into `rex/zinn` under `$XDG_CONFIG_HOME` when that is set:",
          },
        ],
      },
      {
        kind: "code",
        label: "Download the Zinn actions for Rex",
        language: "sh",
        commands: rexActions.commands,
      },
      {
        kind: "prose",
        blocks: [{ kind: "paragraph", text: "Then load the actions in `init.lua`:" }],
      },
      {
        kind: "code",
        label: "Load the Zinn actions in init.lua",
        language: "lua",
        commands: [rexActions.require],
      },
      {
        kind: "prose",
        blocks: [{ kind: "paragraph", text: "And reload the configuration:" }],
      },
      {
        kind: "code",
        label: "Reload the Rex configuration",
        language: "sh",
        commands: [rexActions.reload],
      },
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: 'To load one action only, require it by name, such as `require("zinn.new_task")`. To remove the actions, delete the folder and the `require` line.',
          },
          {
            kind: "paragraph",
            text: `Run the download again to update the files to the current version, ${rexActions.version}. \`${rexActions.versionCheck}\` returns the version you have, and the [changelog](${rexActions.changelog}) lists the changes.`,
            markdownHrefOverrides: { [rexActions.changelog]: `${rexActions.changelog}.md` },
          },
          {
            kind: "paragraph",
            text: `The download fetches ${rexActions.files
              .map((name) => `[${name}](${rexActions.downloadBase}/${name})`)
              .join(", ")}.`,
          },
          {
            kind: "paragraph",
            text: `Rex's [configuration reference](${rexActions.configDocs}) says where \`init.lua\` lives.`,
          },
          {
            kind: "details",
            summary: "Windows",
            paragraph:
              "On Windows, the folder goes in `%AppData%\\rex\\`. Windows 10 and later include `curl` and `tar`, so in Command Prompt this fetches the folder from GitHub:",
            code: {
              kind: "code",
              label: "Download the Zinn actions for Rex on Windows",
              language: "bat",
              commands: [rexActions.windowsCommand],
              showsPrompt: false,
            },
          },
        ],
      },
    ],
  },
  {
    id: "keys-and-arguments",
    headingId: "keys-heading",
    title: "Keys and arguments",
    surface: "bone",
    titleSide: "right",
    blocks: [
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: "The actions come without key bindings. Bind keys to `zinn_new_task`, `zinn_insert_task` and `zinn_resume_session` in `init.lua`:",
          },
        ],
      },
      {
        kind: "code",
        label: "Bind keys to the Zinn actions",
        language: "lua",
        commands: rexActions.bindings,
      },
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: "An action asks for nothing it is given as an argument. With `project`, Zinn: New task files the task there without asking:",
          },
        ],
      },
      {
        kind: "code",
        label: "Bind a key that files tasks in one project",
        language: "lua",
        commands: [rexActions.projectBinding],
      },
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: "With `title` as well, it asks nothing, which suits scripts:",
          },
        ],
      },
      {
        kind: "code",
        label: "Create a task from a script",
        language: "sh",
        commands: [rexActions.scriptCommand],
      },
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: "Zinn: Insert task takes `task` to paste that task without showing the list:",
          },
        ],
      },
      {
        kind: "code",
        label: "Bind a key that pastes one task",
        language: "lua",
        commands: [rexActions.taskBinding],
      },
      {
        kind: "prose",
        blocks: [{ kind: "paragraph", text: "Zinn: Resume session takes `task` the same way." }],
      },
    ],
  },
  {
    id: "calls-to-zinn",
    headingId: "calls-heading",
    title: "Calls to Zinn",
    surface: "limestone",
    blocks: [
      {
        kind: "prose",
        blocks: [
          {
            kind: "paragraph",
            text: "The actions run `zinn` only when you use one. While they are unused they make no calls, so none that you did not trigger, in use or idle.",
          },
          {
            kind: "paragraph",
            text: "Each use of Zinn: New task makes at most two calls, `project list` and `task create`, or only `task create` when `project` is given. Each use of Zinn: Insert task makes at most two, `task list` and `task view`, or only `task view` when `task` is given. Each use of Zinn: Resume session makes at most two, `task list` and `activity list`, or only `activity list` when `task` is given.",
          },
          {
            kind: "paragraph",
            text: "Each call names its action in the [client chain](/docs/cli/identity#client-chains), as `zinn-rex:new-task/<version>`, `zinn-rex:insert-task/<version>` or `zinn-rex:resume-session/<version>`.",
          },
        ],
      },
    ],
  },
];
