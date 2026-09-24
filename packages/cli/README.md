# @zinn-dev/cli

The `zinn` command-line interface. Requires [Bun](https://bun.sh).

## Install

```sh
bun add --global @zinn-dev/cli
```

Zinn stores projects and tasks in the shared local database at `~/.zinn/data/zinn.sqlite`.
Set `ZINN_DIR` to use another Zinn directory and keep using the same value for commands that should share that database.

## Start a project

Create a project with a key or optionally provide a name:

```sh
zinn project create MDR --name "Macrodata Refinement"
```

Project keys are stored in **uppercase**. You can create a project without a project name, like `zinn project create MDR`, which will just default to having the key as the project name too.
Intetionally empty or whitespace project names are rejected.

Each project starts with _Backlog_, _TODO_, _In Progress_, _Review_, and _Done_ columns.

You can list projects or inspect a project's columns with:

```sh
zinn project list
zinn project view MDR
zinn project column list MDR
```

`project view` prints the project and its unarchived tasks. It's the same list as you would get with `zinn task list <project-key>`.

Rename a project:

```sh
zinn project edit MDR --name "Macrodata Refinement (Morning Shift)"
```

The `--name` flag is required. Names must contain printable text on a single line.
Supplying the current name leaves the modification timestamp unchanged.
Use `--name="--example"` when a value begins with a dash.

Add another column at the end of the board:

```sh
zinn project column create MDR "Boardlog"
```

`zinn project delete MDR` asks for confirmation, then permanently deletes the project and all of its columns and tasks.

## Create and read tasks

Create a task with a title and an optional description. New tasks enter the project's first column:

```sh
zinn task create MDR --title "Refine 75% of the numbers"
zinn task create MDR --title "Review the employee handbook" --description "Prepare for a 75% Dance Experience"
```

Tasks are created with keys such as `MDR-1`. List active tasks, optionally limited to one project, or view one task:

```sh
zinn task list
zinn task list MDR
zinn task view MDR-1
```

When a project key is supplied, the list follows the project's column order and the task order within each column.

## Labels

Labels are global and reusable in all the available projects.

```sh
zinn label create urgent --color red --description "Needs attention soon"
zinn label create review
zinn label list
```

### Adding to tasks

```sh
zinn task create MDR --title "Check the numbers" --label urgent --label review
zinn task label add MDR-1 urgent review
zinn task label remove MDR-1 review
zinn task edit MDR-1 --add-label review --remove-label urgent
```

For adding or removing multiple labels at the same time, repeat `--label` on creation, or `--add-label` and `--remove-label` while editing for each label.
Each value is considered as the label name: `--label "needs review"`, so if you have commas, then they are considered parts of names.
Label names are case-sensitive, and the whitespace from input is trimmed.

Descriptions default to an empty string and the label colors default to white. Available colors are _red_, _green_, _yellow_, _blue_, _magenta_, _cyan_, _white_, and _gray_.

`label create` and `label list` print each label name in its color. `--json` output shows the color as a value instead.

Task creation and edits apply content and label changes together, or roll back together on failure.
Note that label changes also update the task's modification timestamp. Archived tasks can also have their labels edited.

Commands like `task view` and task mutation output show attached labels.

`zinn label delete urgent` asks for confirmation, then deletes the definition and removes it from every task. Declining confirmation leaves the label and its attachments unchanged.
Use `task label remove` to remove a label attachment from one task instead. Task/project deletion cleans up label attachments, but does not affect labels themselves.

## Task relations

```sh
zinn task relation create MDR-1 MDR-2 --type dependency
zinn task relation create MDR-1 MDR-2 --type duplicate
zinn task relation create MDR-1 OTHER-1 --type related
zinn task relation list MDR-1
```

`dependency` means the first task depends on the second, `duplicate` means the first task is a duplicate of the second. `related` is a bit different as the order of the tasks mentioned _does not matter_, either case describes the same relation.

Relations do not have any side effects. They are purely for information.
Tasks from separate projects can be related to each other. Tasks can also be related to archived tasks.

`task view` a task's existing relations.

Remove a relation with `zinn task relation delete MDR-1 MDR-2 --type dependency`, using its original direction for `dependency` and `duplicate`. For `related`, order does not matter.
Note that a deletion happens _without_ confirmation.

Use `task relation create --help` to discover types.

## Task comments

Add and list comments on a task:

```sh
zinn task comment create MDR-1 --text "Ready for review"
zinn task comment list MDR-1
```

Comments receive keys per task like `MDR-1#1`.
`task view` includes the task's comments.

Edit or delete a comment using its key:

```sh
zinn task comment edit MDR-1#1 --text "Approved"
zinn task comment delete MDR-1#1
```

Deletion asks for confirmation. Comments can be added to archived tasks. Comment mutations are recorded in the activity log without changing the task's modification timestamp.

## Edit tasks

Edit a task's title, description, priority, or labels:

```sh
zinn task edit MDR-1 --title "Meet the quarterly refinement quota"
zinn task edit MDR-1 --description "Complete refinement before the waffle party"
zinn task edit MDR-1 --title "Meet the quarterly refinement quota" --description ""
```

Only the explicitly specified fields are modified and the rest are untouched. An empty string can be given for the description and is considered valid.

At least one flag is required and task titles cannot be blank. Archived tasks can be edited without unarchiving them. Supplying unchanged values does not change the modification timestamp.
Use `--title="--example"` when a value begins with a dash.

## Move and order tasks

Move a task to another column in its project:

```sh
zinn task move MDR-1 "In Progress"
```

A moved task appears at the bottom of its destination column. Moving it to its current column does nothing. Archived tasks must be unarchived before they can be moved.
Moving prints only the task's key and new column, such as `MDR-1 | In Progress`, while `--json` prints the full task details.

Change a task's position within its current column:

```sh
zinn task order MDR-2 top
zinn task order MDR-2 up
zinn task order MDR-2 down
zinn task order MDR-2 bottom
zinn task move MDR-2 "In Progress"
zinn task order MDR-2 before MDR-1
zinn task order MDR-2 after MDR-1
```

The task being reordered and the target of `before` or `after` must be active tasks in the same column.

## Archive and delete tasks

Active tasks are shown by default. Archive a task to hide it from active lists, then list archived tasks or all tasks:

```sh
zinn task archive MDR-1
zinn task list MDR --archived
zinn task list MDR --all
```

`--archived` and `--all` cannot be used together. In an `--all` listing, Zinn adds an Active or Archived status column.

Unarchiving puts a task at the bottom of its previous column:

```sh
zinn task unarchive MDR-1
```

Delete a task permanently with `zinn task delete MDR-1`. It asks for confirmation before performing the action.

## Help

Use root or namespace help to discover commands, then open a command's help for its arguments and behavior:

```sh
zinn --help
zinn project --help
zinn project column --help
zinn task --help
zinn task move --help
```

The short `-h` form works in the same positions.

Running `zinn` without a command shows help

## Task priority

Priority is optional: `low`, `medium`, `high`, or `urgent`. New tasks have no assigned priority by default.

```sh
zinn task create MDR --title "Review the numbers" --priority high
zinn task edit MDR-1 --priority urgent
zinn task edit MDR-1 --priority none
```

Use `none` to clear priority. Omitting `--priority` on edits preserves it. Task lists show priority in a compact column after the board column: `-` for unassigned and `L`, `M`, `H`, or `U` for low, medium, high, or urgent. Task views show the full priority value. Priority does not affect board ordering.

## Activity

Zinn keeps an activity log of changes made to a task like creating, editing, moving, reordering, archiving, unarchiving and deleting it, its labels, its relations, and its comments. Each log also says _who_ made the change.
Note that this data is not yet surfaced by any command yet.

When a coding agent performs a mutation with `zinn`, the change is recorded under that agent's name.

Zinn recognizes Claude Code, Codex, OpenCode, Gemini CLI, Cline, Cursor, Copilot's coding agent, Crush, Amp, and any tool that sets `AI_AGENT`. If you are using a tool that Zinn does not recognize, you can set `AI_AGENT` in that tool's environment settings, for example `AI_AGENT=hermes`. Otherwise, Zinn uses your git `user.name` and `user.email`, and if that's also not set, it falls to your system username.
