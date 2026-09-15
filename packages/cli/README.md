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
zinn project column list MDR
```

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
zinn task create MDR "Refine 75% of the numbers"
zinn task create MDR "Review the employee handbook" "Prepare for a 75% Dance Experience"
```

Tasks are created with keys such as `MDR-1`. List active tasks, optionally limited to one project, or view one task:

```sh
zinn task list
zinn task list MDR
zinn task view MDR-1
```

When a project key is supplied, the list follows the project's column order and the task order within each column.

## Edit tasks

Edit a task's title, description, or both:

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
